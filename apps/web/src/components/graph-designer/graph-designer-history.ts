import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";

/**
 * The designer's undo history (item 212, invariant 6): a bounded command
 * stack over template edits. Every edit replaces the draft with a new
 * template (structural sharing keeps that cheap) and records the template it
 * replaced. Consecutive edits with the same `coalesce` key inside a short
 * window (typing in one field, nudging one node) fold into one step.
 */

/** Undo steps kept; the oldest fall off. */
export const GRAPH_DESIGNER_HISTORY_LIMIT = 100;
/** Edits with the same coalesce key closer together than this are one step. */
export const GRAPH_DESIGNER_COALESCE_MS = 1_500;

export interface GraphHistoryEntry {
  /** What the step did, for the Undo/Redo titles: "Add agent node". */
  label: string;
  /** The template before (undo) or after (redo) the step. */
  template: GraphTemplateV1;
  coalesce?: string;
  at: number;
}

export interface GraphEditHistory {
  past: GraphHistoryEntry[];
  future: GraphHistoryEntry[];
}

export const EMPTY_GRAPH_HISTORY: GraphEditHistory = Object.freeze({
  past: [],
  future: [],
}) as GraphEditHistory;

/** Records `before` as an undo step for an edit labelled `label`. */
export function pushGraphHistory(
  history: GraphEditHistory,
  before: GraphTemplateV1,
  label: string,
  options: { coalesce?: string; now?: number; limit?: number } = {},
): GraphEditHistory {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? GRAPH_DESIGNER_HISTORY_LIMIT;
  const top = history.past.at(-1);
  if (
    options.coalesce !== undefined &&
    top?.coalesce === options.coalesce &&
    now - top.at < GRAPH_DESIGNER_COALESCE_MS
  ) {
    // Same field, still typing: keep the step's original "before".
    const past = [...history.past];
    past[past.length - 1] = { ...top, at: now };
    return { past, future: [] };
  }
  const entry: GraphHistoryEntry = {
    label,
    template: before,
    ...(options.coalesce !== undefined ? { coalesce: options.coalesce } : {}),
    at: now,
  };
  const past = [...history.past, entry];
  return { past: past.length > limit ? past.slice(past.length - limit) : past, future: [] };
}

/** One step back: the template to show and the new history, or null at the start. */
export function undoGraphHistory(
  history: GraphEditHistory,
  current: GraphTemplateV1,
): { template: GraphTemplateV1; history: GraphEditHistory; label: string } | null {
  const entry = history.past.at(-1);
  if (!entry) return null;
  return {
    template: entry.template,
    label: entry.label,
    history: {
      past: history.past.slice(0, -1),
      future: [...history.future, { label: entry.label, template: current, at: entry.at }],
    },
  };
}

/** One step forward again, or null when nothing was undone. */
export function redoGraphHistory(
  history: GraphEditHistory,
  current: GraphTemplateV1,
): { template: GraphTemplateV1; history: GraphEditHistory; label: string } | null {
  const entry = history.future.at(-1);
  if (!entry) return null;
  return {
    template: entry.template,
    label: entry.label,
    history: {
      // A redone step never coalesces with the next edit.
      past: [...history.past, { label: entry.label, template: current, at: 0 }],
      future: history.future.slice(0, -1),
    },
  };
}
