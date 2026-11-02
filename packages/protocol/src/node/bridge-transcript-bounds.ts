/**
 * The display-transcript bound and revised-row bookkeeping the Pi and Cursor
 * bridges share.
 *
 * Both bridges hold one transcript per session and serve it to readers that
 * re-read only the live window. They used to carry identical copies of this
 * module; each now builds one instance from its own limits.
 *
 * Trimming is display-only. Lifecycle (running tools, parked approvals,
 * sub-agents) lives outside `messages`, so dropping a card is never evidence
 * that the work behind it stopped, and never resolves an approval parked on it.
 */

import { RecentlyRevisedRows } from "./revised-rows.js";
import {
  boundTranscriptInPlace,
  TranscriptRowSizes,
  type BoundableTranscriptState,
  type TranscriptLimits,
} from "./transcript-budget.js";

export interface BridgeTranscriptRow {
  id: string;
  parts: readonly unknown[];
}

export interface BridgeTranscriptState extends BoundableTranscriptState {
  messages: BridgeTranscriptRow[];
  /** The revision readers compare to learn that anything changed. */
  revision: number;
}

export interface BridgeTranscriptBoundsOptions extends TranscriptLimits {
  /** Charged growth between exact measurements while streaming. */
  streamIntervalBytes: number;
}

export interface BridgeTranscriptBounds<TState extends BridgeTranscriptState> {
  readonly streamIntervalBytes: number;
  /**
   * Bring the transcript back inside its budget. Structural bounds first, then
   * the byte bound, which re-measures only the newest row and the rows noted
   * since the last pass. Notes retained rows that shed parts; returns true when
   * anything was dropped.
   */
  boundTranscript(state: TState): boolean;
  /** {@link boundTranscript} when the write path charged anything since the last pass. */
  boundTranscriptForRead(state: TState): void;
  /** Whether a streaming update has moved the transcript far enough to bound it now. */
  streamingBoundDue(state: TState): boolean;
  /** Charge appended bytes (an upper bound on encoded growth) to the dirty counter. */
  chargeTranscript(state: TState, bytes: number): void;
  /** Note that the row `id` changed in place. */
  noteRowRevised(state: TState, id: string): void;
  /** Note a change to one row and bump the revision readers compare. */
  rowChanged(state: TState, row: BridgeTranscriptRow): void;
  /**
   * Measure `row` again at the next bound without noting it for readers: for
   * a change readers cannot hold a copy of yet, such as a history being
   * rebuilt.
   */
  forgetRowSize(state: TState, row: BridgeTranscriptRow): void;
  revisedRowsOverflowVersion(state: TState): number;
  revisedRowIds(state: TState): string[] | undefined;
  /** The history was replaced: forget every note and remembered size taken from it. */
  forgetRevisedRows(state: TState): void;
}

export function createBridgeTranscriptBounds<TState extends BridgeTranscriptState>(
  options: BridgeTranscriptBoundsOptions,
): BridgeTranscriptBounds<TState> {
  const limits: TranscriptLimits = {
    maxMessages: options.maxMessages,
    maxPartsPerMessage: options.maxPartsPerMessage,
    maxTranscriptBytes: options.maxTranscriptBytes,
  };
  // Held off the state object so no persistence path can pick them up; a
  // restored session starts with neither.
  const revisedRows = new WeakMap<TState, RecentlyRevisedRows>();
  const rowSizes = new WeakMap<TState, TranscriptRowSizes>();

  const sizesFor = (state: TState): TranscriptRowSizes => {
    let sizes = rowSizes.get(state);
    if (!sizes) {
      sizes = new TranscriptRowSizes();
      rowSizes.set(state, sizes);
    }
    return sizes;
  };

  const noteRowRevised = (state: TState, id: string): void => {
    // Every in-place change to a row reaches here, which is what makes a
    // remembered size safe to reuse until then.
    rowSizes.get(state)?.invalidate(id);
    // The newest row is always inside the live window; only a row that changes
    // once a newer one exists can be outside it.
    if (state.messages.at(-1)?.id === id) return;
    let rows = revisedRows.get(state);
    if (!rows) {
      rows = new RecentlyRevisedRows();
      revisedRows.set(state, rows);
    }
    rows.note(id);
  };

  const boundTranscript = (state: TState): boolean => {
    const rowsBefore = state.messages.slice();
    const partsBefore = rowsBefore.map((row) => row.parts.length);
    const trimmed = boundTranscriptInPlace(state, limits, sizesFor(state));
    if (!trimmed) return false;
    // Rows go only from the front, so what is left lines up with the tail of
    // `rowsBefore`.
    const offset = rowsBefore.length - state.messages.length;
    state.messages.forEach((row, index) => {
      if (row.parts.length < partsBefore[index + offset]!) noteRowRevised(state, row.id);
    });
    return true;
  };

  return {
    streamIntervalBytes: options.streamIntervalBytes,
    boundTranscript,
    boundTranscriptForRead(state) {
      // Zero means these exact messages were already measured; an
      // unconditional bound would make every poll of a large idle session
      // measure it again.
      if (state.uncheckedTranscriptBytes === 0) return;
      if (boundTranscript(state)) state.revision += 1;
    },
    streamingBoundDue(state) {
      return (
        state.messages.length > limits.maxMessages ||
        (state.messages.at(-1)?.parts.length ?? 0) > limits.maxPartsPerMessage ||
        state.uncheckedTranscriptBytes >= options.streamIntervalBytes
      );
    },
    chargeTranscript(state, bytes) {
      if (bytes > 0) state.uncheckedTranscriptBytes += bytes;
    },
    noteRowRevised,
    rowChanged(state, row) {
      noteRowRevised(state, row.id);
      state.revision += 1;
    },
    forgetRowSize(state, row) {
      rowSizes.get(state)?.invalidate(row.id);
    },
    revisedRowsOverflowVersion(state) {
      return revisedRows.get(state)?.overflowVersion ?? 0;
    },
    revisedRowIds(state) {
      const ids = revisedRows.get(state)?.ids();
      return ids && ids.length > 0 ? ids : undefined;
    },
    forgetRevisedRows(state) {
      revisedRows.get(state)?.clear();
      rowSizes.get(state)?.clear();
    },
  };
}
