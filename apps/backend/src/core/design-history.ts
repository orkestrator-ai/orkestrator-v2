import { randomUUID } from "node:crypto";
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  DESIGN_MAX_DOCUMENT_BYTES,
  type DesignFrame,
  type DesignHistoryStatus,
} from "@orkestrator/protocol/design-canvas";
import {
  DESIGN_LIMITS,
  type DesignActor,
  type DesignCheckpointPreview,
  type DesignHistoryEntrySummary,
  type DesignHistoryPage,
} from "@orkestrator/protocol/design-operations";
import { DesignError } from "./design-errors.js";
import {
  readBounded,
  writeAtomically,
  type DesignHistoryEntryRecord,
  type DesignPrivateRecord,
  type DesignRecordStore,
} from "./design-records.js";
import { frameSchema } from "./design-schemas.js";

/** The newest entries per canvas that global pruning must never remove. */
export const PROTECTED_HISTORY_ENTRIES = 3;

export interface DesignCheckpointFrame {
  frameId: string;
  before: DesignFrame | null;
  after: DesignFrame | null;
  beforeIndex?: number;
  afterIndex?: number;
}

export interface DesignCheckpoint {
  entryId: string;
  canvasId: string;
  frames: DesignCheckpointFrame[];
  canvasName?: { before: string; after: string };
}

const checkpointSchema = z
  .object({
    entryId: z.string().max(64),
    canvasId: z.string().max(64),
    frames: z
      .array(
        z.object({
          frameId: z.string().max(64),
          before: frameSchema.nullable(),
          after: frameSchema.nullable(),
          beforeIndex: z.number().int().nonnegative().optional(),
          afterIndex: z.number().int().nonnegative().optional(),
        }),
      )
      .max(128),
    canvasName: z.object({ before: z.string(), after: z.string() }).optional(),
  })
  .strict();

export function checkpointFile(store: DesignRecordStore, canvasId: string, file: string) {
  if (!/^[a-zA-Z0-9-]{1,80}\.json$/.test(file))
    throw new DesignError("storage", "Invalid checkpoint");
  return join(store.historyDir(canvasId), file);
}

/** Written and synced before any record references it. */
export async function writeCheckpoint(
  store: DesignRecordStore,
  checkpoint: DesignCheckpoint,
): Promise<{ file: string; bytes: number }> {
  const file = `${checkpoint.entryId}-${randomUUID().slice(0, 8)}.json`;
  const bytes = Buffer.from(JSON.stringify(checkpoint));
  if (bytes.byteLength > DESIGN_MAX_DOCUMENT_BYTES * 2 + 64 * 1024)
    throw new DesignError("capacity", "History checkpoint exceeds its size limit", {
      retry: "never",
    });
  await writeAtomically(checkpointFile(store, checkpoint.canvasId, file), bytes, store.faults);
  return { file, bytes: bytes.byteLength };
}

export async function readCheckpoint(
  store: DesignRecordStore,
  canvasId: string,
  entry: DesignHistoryEntryRecord,
): Promise<DesignCheckpoint> {
  try {
    const raw = await readBounded(
      checkpointFile(store, canvasId, entry.checkpoint),
      DESIGN_MAX_DOCUMENT_BYTES * 2 + 64 * 1024,
    );
    return checkpointSchema.parse(JSON.parse(raw.toString("utf8"))) as DesignCheckpoint;
  } catch {
    throw new DesignError("history-ineligible", "This history checkpoint is no longer available", {
      retry: "never",
    });
  }
}

export function historyLabel(kind: string, frames: string[]): string {
  const target =
    frames.length === 1
      ? ` “${frames[0]!.slice(0, 40)}”`
      : frames.length
        ? ` ${frames.length} frames`
        : "";
  const labels: Record<string, string> = {
    create_frame: "Add frame",
    update_frame: "Move or resize frame",
    replace_frame_html: "Replace frame HTML",
    append_frame_html: "Append to frame",
    set_element_styles: "Change styles",
    replace_element_html: "Replace element",
    move_element: "Move element",
    duplicate_frame: "Duplicate frame",
    delete_frame: "Delete frame",
    rename_canvas: "Rename design",
    restore_checkpoint: "Restore checkpoint",
    undo: "Undo",
    redo: "Redo",
    batch: "Grouped edit",
  };
  return `${labels[kind] ?? kind}${target}`;
}

function isOrdinary(entry: DesignHistoryEntryRecord) {
  return entry.kind !== "undo";
}

function actorMatches(entry: DesignHistoryEntryRecord, actor: DesignActor, scope: "own" | "any") {
  return scope === "any" || entry.actor === actor;
}

/** Latest entry the actor may undo, whether or not it is currently eligible. */
export function undoCandidate(
  record: DesignPrivateRecord,
  actor: DesignActor,
  scope: "own" | "any" = "own",
): DesignHistoryEntryRecord | undefined {
  for (let index = record.history.entries.length - 1; index >= 0; index--) {
    const entry = record.history.entries[index]!;
    if (!entry.undone && isOrdinary(entry) && actorMatches(entry, actor, scope)) return entry;
  }
  return undefined;
}

/** Un-reversed undos, newest first, until a newer ordinary edit by the actor superseded them. */
function redoChain(
  record: DesignPrivateRecord,
  actor: DesignActor,
  scope: "own" | "any",
): DesignHistoryEntryRecord[] {
  const chain: DesignHistoryEntryRecord[] = [];
  for (let index = record.history.entries.length - 1; index >= 0; index--) {
    const entry = record.history.entries[index]!;
    if (!actorMatches(entry, actor, scope)) continue;
    if (entry.kind === "undo") {
      if (!entry.undone) chain.push(entry);
      continue; // an undone undo was already redone
    }
    if (entry.redoOf || entry.undone) continue; // part of the undo/redo chain
    break; // a newer ordinary edit invalidated the redo branch
  }
  return chain;
}

/** Latest un-reversed undo, unless a newer ordinary edit by the actor superseded it. */
export function redoCandidate(
  record: DesignPrivateRecord,
  actor: DesignActor,
  scope: "own" | "any" = "own",
): DesignHistoryEntryRecord | undefined {
  return redoChain(record, actor, scope)[0];
}

/** The undo entry a redo entry reversed: the latest undo of its target before it. */
function reversedUndo(entries: DesignHistoryEntryRecord[], index: number, redoOf: string) {
  for (let earlier = index - 1; earlier >= 0; earlier--) {
    const candidate = entries[earlier]!;
    if (candidate.kind === "undo" && candidate.undoOf === redoOf) return candidate;
  }
  return undefined;
}

/**
 * Revision equivalence: an undo restores its target's before-state and a redo
 * restores its undo's before-state, so when an inverse was applied on top of
 * (a state equal to) what it reverses, the revision it produced stands for the
 * revision it restored. Successive undos/redos of one target therefore chain,
 * while any other intervening edit still breaks eligibility.
 */
function revisionEquivalence(
  record: DesignPrivateRecord,
  revisionsOf: (entry: DesignHistoryEntryRecord) => { before?: number; after?: number } | undefined,
): (a: number, b: number) => boolean {
  const parent = new Map<number, number>();
  const find = (value: number): number => {
    let root = value;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(value, root);
    return root;
  };
  const same = (a: number, b: number) => find(a) === find(b);
  const entries = record.history.entries;
  entries.forEach((entry, index) => {
    const produced = revisionsOf(entry);
    if (produced?.after === undefined) return;
    const restored =
      entry.kind === "undo" && entry.undoOf
        ? entries.find((candidate) => candidate.id === entry.undoOf)
        : entry.redoOf
          ? reversedUndo(entries, index, entry.redoOf)
          : undefined;
    const source = restored ? revisionsOf(restored) : undefined;
    if (!source || source.before === undefined) return;
    const appliedOnTarget =
      produced.before === undefined
        ? source.after === undefined
        : source.after !== undefined && same(produced.before, source.after);
    if (appliedOnTarget) parent.set(find(produced.after), find(source.before));
  });
  return same;
}

/** An inverse applies only while its targets still have exactly the recorded versions. */
export function eligibility(
  record: DesignPrivateRecord,
  entry: DesignHistoryEntryRecord,
): { eligible: true } | { eligible: false; reason: string } {
  const current = new Map(record.document.frames.map((frame) => [frame.id, frame]));
  if (
    entry.scope === "canvas" &&
    !revisionEquivalence(record, (candidate) => ({
      before: candidate.canvasRevisionBefore,
      after: candidate.canvasRevisionAfter,
    }))(record.document.revision, entry.canvasRevisionAfter)
  )
    return { eligible: false, reason: "The design changed after this edit" };
  let restoring = 0;
  for (const frame of entry.frames) {
    const now = current.get(frame.frameId);
    if (frame.after === undefined) {
      if (now) return { eligible: false, reason: `“${frame.name}” was recreated after this edit` };
      restoring++;
    } else if (
      !now ||
      !revisionEquivalence(record, (candidate) =>
        candidate.frames.find((item) => item.frameId === frame.frameId),
      )(now.revision, frame.after)
    ) {
      return {
        eligible: false,
        reason: now
          ? `“${frame.name}” changed after this edit`
          : `“${frame.name}” was deleted after this edit`,
      };
    }
  }
  if (restoring && record.document.frames.length + restoring > 64)
    return { eligible: false, reason: "Frame limit reached (64)" };
  return { eligible: true };
}

export function historyStatus(
  record: DesignPrivateRecord,
  actor: DesignActor = "user",
): DesignHistoryStatus {
  const undo = undoCandidate(record, actor);
  const redos = redoChain(record, actor, "own");
  const redo = redos[0];
  const undoCheck = undo ? eligibility(record, undo) : undefined;
  const redoCheck = redo ? eligibility(record, redo) : undefined;
  const undoCount = record.history.entries.filter(
    (entry) => !entry.undone && isOrdinary(entry) && entry.actor === actor,
  ).length;
  return {
    revision: record.document.revision,
    undoCount,
    redoCount: redos.length,
    canUndo: undoCheck?.eligible === true,
    canRedo: redoCheck?.eligible === true,
    ...(undo ? { undoLabel: undo.label } : {}),
    ...(redo ? { redoLabel: redo.label.replace(/^Undo /, "") } : {}),
    ...(undoCheck && !undoCheck.eligible ? { undoBlockedReason: undoCheck.reason } : {}),
    ...(redoCheck && !redoCheck.eligible ? { redoBlockedReason: redoCheck.reason } : {}),
  };
}

export function summarize(entry: DesignHistoryEntryRecord, protectedIds: Set<string>) {
  const summary: DesignHistoryEntrySummary = {
    id: entry.id,
    kind: entry.kind as DesignHistoryEntrySummary["kind"],
    label: entry.label,
    actor: entry.actor,
    createdAt: entry.createdAt,
    canvasRevisionBefore: entry.canvasRevisionBefore,
    canvasRevisionAfter: entry.canvasRevisionAfter,
    frames: entry.frames,
    undone: entry.undone,
    ...(entry.undoOf ? { undoOf: entry.undoOf } : {}),
    ...(entry.gestureId ? { gestureId: entry.gestureId } : {}),
    protected: protectedIds.has(entry.id),
    bytes: entry.bytes,
  };
  return summary;
}

export function protectedEntries(record: DesignPrivateRecord): Set<string> {
  return new Set(record.history.entries.slice(-PROTECTED_HISTORY_ENTRIES).map((entry) => entry.id));
}

export function historyPage(
  record: DesignPrivateRecord,
  offset = 0,
  limit = 50,
): DesignHistoryPage {
  const newest = [...record.history.entries].reverse();
  const bounded = Math.max(1, Math.min(100, limit));
  const start = Math.max(0, offset);
  const protectedIds = protectedEntries(record);
  const entries = newest
    .slice(start, start + bounded)
    .map((entry) => summarize(entry, protectedIds));
  return {
    entries,
    total: newest.length,
    ...(start + bounded < newest.length ? { nextOffset: start + bounded } : {}),
    bytes: record.history.bytes,
    limits: {
      entries: DESIGN_LIMITS.historyEntriesPerCanvas,
      bytes: DESIGN_LIMITS.historyBytesPerCanvas,
    },
  };
}

export async function checkpointPreview(
  store: DesignRecordStore,
  record: DesignPrivateRecord,
  entryId: string,
  side: "before" | "after",
): Promise<DesignCheckpointPreview> {
  const entry = record.history.entries.find((candidate) => candidate.id === entryId);
  if (!entry) throw new DesignError("not-found", "History entry not found");
  const checkpoint = await readCheckpoint(store, record.canvasId, entry);
  return {
    entryId,
    side,
    frames: checkpoint.frames.map((frame) => ({
      frameId: frame.frameId,
      frame: side === "before" ? frame.before : frame.after,
    })),
    ...(checkpoint.canvasName
      ? {
          canvasName:
            side === "before" ? checkpoint.canvasName.before : checkpoint.canvasName.after,
        }
      : {}),
  };
}

/**
 * Appends (or merges a same-gesture) entry and prunes within the per-canvas
 * budgets. Returns checkpoint files that are no longer referenced once the new
 * record is committed; callers delete them only after the commit succeeds.
 */
export function gestureMergeTarget(
  record: DesignPrivateRecord,
  draft: Pick<DesignHistoryEntryRecord, "gestureId" | "actor" | "kind" | "frames">,
): DesignHistoryEntryRecord | undefined {
  const last = record.history.entries.at(-1);
  if (
    draft.gestureId &&
    last &&
    last.gestureId === draft.gestureId &&
    last.actor === draft.actor &&
    !last.undone &&
    last.kind === draft.kind &&
    last.frames.length === draft.frames.length &&
    last.frames.every(
      (frame, index) =>
        frame.frameId === draft.frames[index]?.frameId &&
        frame.after !== undefined &&
        frame.after === draft.frames[index]?.before,
    )
  )
    return last;
  return undefined;
}

export function appendEntry(
  record: DesignPrivateRecord,
  entry: DesignHistoryEntryRecord,
  merged?: DesignHistoryEntryRecord,
): { obsolete: string[] } {
  const obsolete: string[] = [];
  const entries = record.history.entries;
  if (merged && entries.at(-1)?.id === merged.id) {
    // One gesture, one history boundary: the caller kept `merged`'s before state.
    obsolete.push(merged.checkpoint);
    entries.pop();
  }
  entries.push(entry);
  while (entries.length > DESIGN_LIMITS.historyEntriesPerCanvas) {
    obsolete.push(entries.shift()!.checkpoint);
  }
  recount(record);
  while (
    record.history.bytes > DESIGN_LIMITS.historyBytesPerCanvas &&
    entries.length > PROTECTED_HISTORY_ENTRIES
  ) {
    obsolete.push(entries.shift()!.checkpoint);
    recount(record);
  }
  if (record.history.bytes > DESIGN_LIMITS.historyBytesPerCanvas)
    throw new DesignError(
      "capacity",
      "This edit cannot be made undoable within the design history budget",
      { retry: "never" },
    );
  return { obsolete };
}

/** Drops the oldest unprotected entry; returns its checkpoint file or undefined. */
export function dropOldestUnprotected(record: DesignPrivateRecord): string | undefined {
  if (record.history.entries.length <= PROTECTED_HISTORY_ENTRIES) return undefined;
  const removed = record.history.entries.shift()!;
  recount(record);
  return removed.checkpoint;
}

function recount(record: DesignPrivateRecord) {
  record.history.bytes = record.history.entries.reduce((total, entry) => total + entry.bytes, 0);
}

export async function deleteCheckpoints(
  store: DesignRecordStore,
  canvasId: string,
  files: string[],
) {
  for (const file of files) {
    await unlink(checkpointFile(store, canvasId, file)).catch(() => undefined);
  }
}

/**
 * Removes unreferenced checkpoint files older than `minAgeMs`. A writer that
 * has not yet published its reference is younger than the threshold.
 */
export async function collectOrphans(
  store: DesignRecordStore,
  canvasId: string,
  referenced: Set<string>,
  minAgeMs = 10 * 60_000,
  maxFiles = 512,
): Promise<number> {
  let files: string[];
  try {
    files = (await readdir(store.historyDir(canvasId))).slice(0, maxFiles);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const file of files) {
    if (referenced.has(file) || !file.endsWith(".json")) continue;
    const path = join(store.historyDir(canvasId), file);
    try {
      if (Date.now() - (await stat(path)).mtimeMs < minAgeMs) continue;
      await unlink(path);
      removed++;
    } catch {
      // Best effort; a concurrent delete is fine.
    }
  }
  return removed;
}
