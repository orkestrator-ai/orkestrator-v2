import type { DesignFrame } from "@orkestrator/protocol/design-canvas";
import type {
  DesignChangeDescriptor,
  DesignFrameMeta,
  DesignOperationResult,
} from "@orkestrator/protocol/design-operations";
import { DesignError, designConflict } from "./design-errors.js";
import type { ComputedOperation } from "./design-execute.js";
import type { DesignCheckpoint } from "./design-history.js";
import {
  freshFrameMeta,
  nextIdentity,
  pushChange,
  unvalidated,
  type DesignHistoryEntryRecord,
  type DesignPrivateRecord,
} from "./design-records.js";

export interface AppliedOperation {
  result: DesignOperationResult;
  checkpoint?: Omit<DesignCheckpoint, "entryId">;
  historyFrames: DesignHistoryEntryRecord["frames"];
}

/** Re-verifies a computed result against the latest record. Throws on any drift. */
export function verifyComputed(record: DesignPrivateRecord, computed: ComputedOperation): void {
  if (record.state === "deleted")
    throw new DesignError("deleted", "This design was deleted", { retry: "never" });
  if (record.state !== "live") throw new DesignError("not-found", "Canvas not found");
  const target = { canvasId: record.canvasId };
  // Deleting (and restoring) a design changes its incarnation: work computed
  // against the earlier incarnation must not land in the restored design.
  if (computed.incarnation !== undefined && computed.incarnation !== record.incarnation)
    throw new DesignError("conflict", "The design was deleted or restored while this edit ran", {
      target,
    });
  if (computed.canvasRevision !== undefined && computed.canvasRevision !== record.document.revision)
    throw designConflict(computed.canvasRevision, record.document.revision, target);
  const frames = new Map(record.document.frames.map((frame) => [frame.id, frame]));
  for (const expected of computed.frameRevisions) {
    const frame = frames.get(expected.frameId);
    if (!frame)
      throw new DesignError("conflict", "The frame was deleted", {
        target: { ...target, frameId: expected.frameId },
      });
    if (frame.revision !== expected.revision)
      throw designConflict(expected.revision, frame.revision, { ...target, frameId: frame.id });
  }
  for (const check of computed.structureChecks) {
    if (record.frames[check.frameId]?.structureId !== check.structureId)
      throw new DesignError("conflict", "The frame structure changed; reselect the element", {
        target: { ...target, frameId: check.frameId },
      });
  }
  for (const change of computed.frames) {
    if (!change.base && change.next && frames.has(change.next.id))
      throw new DesignError("conflict", "Frame already exists", { target });
  }
}

/**
 * Applies a verified computation to `record` in place (callers pass a clone).
 * Revisions only ever increase; identities are fresh on every relevant change.
 */
export function applyComputed(
  record: DesignPrivateRecord,
  computed: ComputedOperation,
  now: string,
): AppliedOperation {
  const doc = record.document;
  const resultFrames: DesignOperationResult["frames"] = [];
  const checkpointFrames: DesignCheckpoint["frames"] = [];
  const historyFrames: DesignHistoryEntryRecord["frames"] = [];
  const descriptor: DesignChangeDescriptor = {
    revision: doc.revision + 1,
    frames: [],
    canvasFields: [],
  };
  let createdFrameId: string | undefined;
  for (const change of computed.frames) {
    const index = doc.frames.findIndex((frame) => frame.id === change.frameId);
    const current = index >= 0 ? doc.frames[index]! : null;
    if (!change.next) {
      if (!current) continue;
      doc.frames.splice(index, 1);
      delete record.frames[current.id];
      checkpointFrames.push({
        frameId: current.id,
        before: current,
        after: null,
        beforeIndex: index,
      });
      historyFrames.push({ frameId: current.id, name: current.name, before: current.revision });
      descriptor.frames.push({ id: current.id, fields: change.fields, removed: true });
      resultFrames.push({ frameId: current.id, revision: current.revision, removed: true });
      continue;
    }
    // A brand-new frame starts at 1. A frame recreated from history (undo of a
    // delete, checkpoint restore) must never reuse a revision number that once
    // named different content, so it takes the next canvas revision: frame
    // revisions can never exceed the canvas revision that produced them.
    const revision = current
      ? current.revision + 1
      : change.next.revision > 0
        ? Math.max(change.next.revision, doc.revision) + 1
        : 1;
    const next: DesignFrame = {
      id: change.next.id,
      name: change.next.name,
      x: change.next.x,
      y: change.next.y,
      width: change.next.width,
      height: change.next.height,
      html: change.next.html,
      revision,
    };
    let meta: DesignFrameMeta;
    if (!current || !record.frames[next.id]) {
      meta = freshFrameMeta(record, next, now);
      const at = Math.max(0, Math.min(change.index ?? doc.frames.length, doc.frames.length));
      if (current) doc.frames[index] = next;
      else doc.frames.splice(at, 0, next);
      if (!change.base) createdFrameId ??= next.id;
    } else {
      const previous = record.frames[next.id]!;
      meta = { ...previous, modifiedAt: now };
      if (change.fields.includes("content")) meta.contentId = nextIdentity(record);
      if (
        change.fields.includes("structure") ||
        (change.fields.includes("content") && !change.preserveStructure)
      )
        meta.structureId = nextIdentity(record);
      if (change.fields.includes("viewport")) meta.viewportId = nextIdentity(record);
      doc.frames[index] = next;
    }
    if (change.validation) {
      meta.validation = { ...change.validation, frameId: next.id, contentId: meta.contentId };
    } else if (change.carryValidation && current && record.frames[next.id]) {
      meta.validation = { ...record.frames[next.id]!.validation, contentId: meta.contentId };
    } else if (meta.validation.contentId !== meta.contentId) {
      meta.validation = unvalidated(next.id, meta.contentId);
    }
    record.frames[next.id] = meta;
    const afterIndex = doc.frames.findIndex((frame) => frame.id === next.id);
    checkpointFrames.push({
      frameId: next.id,
      before: current,
      after: next,
      ...(current ? { beforeIndex: index } : {}),
      afterIndex,
    });
    historyFrames.push({
      frameId: next.id,
      name: next.name,
      ...(current ? { before: current.revision } : {}),
      after: next.revision,
    });
    descriptor.frames.push({
      id: next.id,
      fields: current ? change.fields : ["name", "geometry", "viewport", "content", "structure"],
      ...(current ? {} : { created: true as const }),
    });
    resultFrames.push({
      frameId: next.id,
      revision: next.revision,
      identity: {
        contentId: meta.contentId,
        structureId: meta.structureId,
        viewportId: meta.viewportId,
      },
    });
  }
  let canvasName: DesignCheckpoint["canvasName"];
  if (computed.canvasName && computed.canvasName.after !== doc.name) {
    canvasName = { before: doc.name, after: computed.canvasName.after };
    doc.name = computed.canvasName.after;
    descriptor.canvasFields.push("name");
  }
  if (descriptor.frames.some((frame) => frame.created || frame.removed))
    descriptor.canvasFields.push("order");
  doc.revision++;
  record.modifiedAt = now;
  pushChange(record, descriptor);
  return {
    result: {
      canvasRevision: doc.revision,
      frames: resultFrames,
      ...(createdFrameId ? { createdFrameId } : {}),
      ...(computed.unchangedProperties?.length
        ? { unchangedProperties: computed.unchangedProperties }
        : {}),
      ...(computed.outcomes ? { outcomes: computed.outcomes } : {}),
      validation: resultFrames
        .filter((frame) => !frame.removed)
        .map((frame) => {
          const validation = record.frames[frame.frameId]!.validation;
          return {
            frameId: frame.frameId,
            state: validation.state,
            warnings: validation.reasons.filter((reason) => reason.code !== "dom-limit").length,
          };
        }),
    },
    checkpoint: {
      canvasId: record.canvasId,
      frames: checkpointFrames,
      ...(canvasName ? { canvasName } : {}),
    },
    historyFrames,
  };
}
