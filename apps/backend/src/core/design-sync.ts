import {
  DESIGN_LIMITS,
  DESIGN_RESPONSE_VERSION,
  type DesignFramePatch,
  type DesignSnapshotEnvelope,
  type DesignSyncResult,
  type DesignTombstone,
  type DesignWorkspaceMeta,
} from "@orkestrator/protocol/design-operations";
import { historyStatus } from "./design-history.js";
import type { DesignPrivateRecord } from "./design-records.js";

export function workspaceMeta(record: DesignPrivateRecord): DesignWorkspaceMeta {
  return {
    recordSequence: record.sequence,
    statusVersion: record.statusVersion,
    incarnation: record.incarnation,
    createdAt: record.createdAt,
    modifiedAt: record.modifiedAt,
    frames: record.frames,
    history: historyStatus(record, "user"),
    ...(record.export ? { export: record.export } : {}),
    ...(record.pendingExport ? { pendingExport: record.pendingExport } : {}),
    sessions: record.sessions,
    ...(record.migratedFromLegacy ? { migratedFromLegacy: true } : {}),
  };
}

export function snapshotEnvelope(
  record: DesignPrivateRecord,
  generation: string,
): DesignSnapshotEnvelope {
  return {
    kind: "snapshot",
    responseVersion: DESIGN_RESPONSE_VERSION,
    generation,
    canvas: record.document,
    workspace: workspaceMeta(record),
  };
}

export function tombstone(
  record: DesignPrivateRecord,
  generation: string,
  restorable: boolean,
): DesignTombstone {
  return {
    kind: "deleted",
    responseVersion: DESIGN_RESPONSE_VERSION,
    generation,
    canvasId: record.canvasId,
    name: record.document.name,
    revision: record.deleted?.revision ?? record.document.revision,
    deletedAt: record.deleted?.deletedAt ?? record.modifiedAt,
    restorable,
    statusVersion: record.statusVersion,
  };
}

/**
 * Builds the net transition from the client's exact base to the current
 * revision, read from one immutable record. Any gap resets to a snapshot.
 */
export function buildSync(
  record: DesignPrivateRecord,
  generation: string,
  clientGeneration: string | undefined,
  after: number,
  clientStatusVersion: number | undefined,
  options: { maxBytes?: number; maxFrames?: number } = {},
): DesignSyncResult {
  const current = record.document.revision;
  const base = { responseVersion: DESIGN_RESPONSE_VERSION, generation };
  if (clientGeneration !== generation)
    return { kind: "reset", ...base, revision: current, reason: "generation" };
  if (after > current)
    return { kind: "reset", ...base, revision: current, reason: "future-cursor" };
  const statusStale =
    clientStatusVersion === undefined || clientStatusVersion < record.statusVersion;
  if (after === current) {
    if (!statusStale)
      return { kind: "unchanged", ...base, revision: current, statusVersion: record.statusVersion };
    return {
      kind: "status",
      ...base,
      revision: current,
      statusVersion: record.statusVersion,
      workspace: workspaceMeta(record),
    };
  }
  const range = record.changes.filter((change) => change.revision > after);
  if (!range.length || range[0]!.revision !== after + 1 || range.at(-1)!.revision !== current)
    return { kind: "reset", ...base, revision: current, reason: "expired-range" };
  for (let index = 1; index < range.length; index++) {
    if (range[index]!.revision !== range[index - 1]!.revision + 1)
      return { kind: "reset", ...base, revision: current, reason: "expired-range" };
  }
  const touched = new Map<string, { existedAtBase: boolean; content: boolean }>();
  let renamed = false;
  let reordered = false;
  for (const change of range) {
    if (change.canvasFields.includes("name")) renamed = true;
    if (change.canvasFields.includes("order")) reordered = true;
    for (const frame of change.frames) {
      const entry = touched.get(frame.id);
      const content =
        frame.fields.includes("content") ||
        frame.fields.includes("structure") ||
        Boolean(frame.created);
      if (!entry) touched.set(frame.id, { existedAtBase: !frame.created, content });
      else entry.content ||= content;
    }
  }
  const maxFrames = options.maxFrames ?? DESIGN_LIMITS.deltaFrames;
  if (touched.size > maxFrames)
    return { kind: "reset", ...base, revision: current, reason: "too-large" };
  const byId = new Map(record.document.frames.map((frame) => [frame.id, frame]));
  const added: DesignFramePatch[] = [];
  const patched: DesignFramePatch[] = [];
  const removed: string[] = [];
  for (const [id, entry] of touched) {
    const frame = byId.get(id);
    const meta = record.frames[id];
    if (!frame || !meta) {
      if (entry.existedAtBase) removed.push(id);
      continue;
    }
    const patch: DesignFramePatch = {
      id,
      revision: frame.revision,
      identity: {
        contentId: meta.contentId,
        structureId: meta.structureId,
        viewportId: meta.viewportId,
      },
      name: frame.name,
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
      meta,
      ...(entry.content || !entry.existedAtBase ? { html: frame.html } : {}),
    };
    (entry.existedAtBase ? patched : added).push(patch);
  }
  const { frames: _frames, ...workspace } = workspaceMeta(record);
  const delta: DesignSyncResult = {
    kind: "delta",
    ...base,
    baseRevision: after,
    revision: current,
    statusVersion: record.statusVersion,
    ...(renamed || reordered
      ? {
          canvas: {
            ...(renamed ? { name: record.document.name } : {}),
            ...(reordered ? { order: record.document.frames.map((frame) => frame.id) } : {}),
          },
        }
      : {}),
    added,
    patched,
    removed,
    workspace,
    ...(statusStale ? { frameMeta: record.frames } : {}),
  };
  const bytes = Buffer.byteLength(JSON.stringify(delta));
  if (bytes > (options.maxBytes ?? DESIGN_LIMITS.deltaBytes))
    return { kind: "reset", ...base, revision: current, reason: "too-large" };
  return delta;
}
