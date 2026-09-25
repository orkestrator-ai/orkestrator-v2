import { randomUUID } from "node:crypto";
import {
  DESIGN_MAX_FRAMES,
  DESIGN_RUNTIME_VERSION,
  type DesignFrame,
  type DesignOperation,
  type DesignStyleResult,
  type DesignValidationReport,
} from "@orkestrator/protocol/design-canvas";
import type {
  DesignActor,
  DesignBatchableInput,
  DesignFrameChangeField,
  DesignFrameValidation,
  DesignOperationDescriptor,
  DesignOperationInput,
  DesignOperationResult,
  DesignValidationReason,
} from "@orkestrator/protocol/design-operations";
import { DesignError, designConflict, isDesignError } from "./design-errors.js";
import {
  eligibility,
  historyLabel,
  readCheckpoint,
  redoCandidate,
  undoCandidate,
  type DesignCheckpoint,
} from "./design-history.js";
import type { DesignPrivateRecord, DesignRecordStore } from "./design-records.js";
import { frameSchema } from "./design-schemas.js";

export type RenderPriority = "interactive" | "validation" | "background";
export type RenderFn = (
  frame: Pick<DesignFrame, "html" | "width" | "height">,
  operation: DesignOperation,
  priority: RenderPriority,
) => Promise<unknown>;

export interface FrameChange {
  frameId: string;
  /** Frame state in the base snapshot (null when created by this operation). */
  base: DesignFrame | null;
  /** New state; null removes the frame. Revision is assigned at apply time. */
  next: DesignFrame | null;
  index?: number;
  fields: DesignFrameChangeField[];
  validation?: Omit<DesignFrameValidation, "frameId" | "contentId">;
  /** Keep structure identity (style-only edits). */
  preserveStructure?: boolean;
  /** Carry validation across a style-only content change. */
  carryValidation?: boolean;
}

export interface ComputedOperation {
  noop: boolean;
  /** Record incarnation the computation read; verified again at commit. */
  incarnation?: string;
  frames: FrameChange[];
  canvasName?: { before: string; after: string };
  /** Canvas-level precondition verified again at commit. */
  canvasRevision?: number;
  /** Frames whose revisions must be unchanged at commit (base revisions). */
  frameRevisions: Array<{ frameId: string; revision: number }>;
  structureChecks: Array<{ frameId: string; structureId: string }>;
  history?: {
    kind: string;
    label: string;
    scope: "frame" | "canvas";
    undoOf?: string;
    redoOf?: string;
    /** Entry to mark undone / reinstated when committing an undo/redo. */
    markUndone?: string;
    markReinstated?: string;
  };
  unchangedProperties?: string[];
  outcomes?: DesignOperationResult["outcomes"];
  /** Frames that need a background validation after commit. */
  validateAfter: string[];
}

export interface ComputeContext {
  record: DesignPrivateRecord;
  descriptor: DesignOperationDescriptor;
  actor: DesignActor;
  render: RenderFn;
  store: DesignRecordStore;
  /** Effective frame revision after predecessor substitution. */
  frameRevision?: number;
}

const HTML_OPS = new Set(["append_frame_html", "replace_element_html", "move_element"]);

function frameOf(record: DesignPrivateRecord, frameId: string): DesignFrame {
  const frame = record.document.frames.find((candidate) => candidate.id === frameId);
  if (!frame) throw new DesignError("not-found", "Frame not found", { target: { frameId } });
  return frame;
}

export function requireRevision(
  expected: number | undefined,
  current: number,
  label: "canvas" | "frame",
  target: { canvasId?: string; frameId?: string },
): number {
  if (expected === undefined)
    throw new DesignError("invalid-input", `Missing expected ${label} revision`, { target });
  if (expected !== current) throw designConflict(expected, current, target);
  return expected;
}

function reasonsOf(report: DesignValidationReport): DesignFrameValidation["reasons"] {
  const reasons: DesignFrameValidation["reasons"] = [];
  const push = (code: DesignValidationReason, count: number) => {
    if (count > 0) reasons.push({ code, count });
  };
  push("scripts-removed", report.removed.scripts);
  push("handlers-removed", report.removed.handlers);
  push("external-references-blocked", report.removed.externalReferences);
  push("forbidden-elements-removed", report.removed.forbiddenElements);
  push("executable-urls-removed", report.removed.executableUrls);
  if (report.overElementLimit) reasons.push({ code: "dom-limit", count: report.elementCount });
  return reasons;
}

export function validationFromReport(
  report: DesignValidationReport,
): Omit<DesignFrameValidation, "frameId" | "contentId"> {
  const reasons = reasonsOf(report);
  const warnings = reasons.filter((reason) => reason.code !== "dom-limit").length;
  return {
    runtimeVersion: DESIGN_RUNTIME_VERSION,
    state: report.overElementLimit ? "invalid" : "valid",
    reasons,
    truncated: false,
    elementCount: report.elementCount,
    validatedAt: new Date().toISOString(),
    message: report.overElementLimit
      ? `This frame has ${report.elementCount} elements; the limit is 5000.`
      : warnings
        ? "Some content was removed or blocked: scripts and external resources never run in designs."
        : undefined,
  };
}

export function unavailableValidation(): Omit<DesignFrameValidation, "frameId" | "contentId"> {
  return {
    runtimeVersion: DESIGN_RUNTIME_VERSION,
    state: "renderer-unavailable",
    reasons: [{ code: "renderer-unavailable" }],
    truncated: false,
    message: "Stored without validation because the design renderer is unavailable.",
  };
}

/** Validates raw HTML before commit when the renderer is healthy. */
async function validateRaw(
  ctx: ComputeContext,
  html: string,
  size: Pick<DesignFrame, "width" | "height">,
): Promise<Omit<DesignFrameValidation, "frameId" | "contentId">> {
  try {
    const report = (await ctx.render(
      { html: "", width: size.width, height: size.height },
      { op: "validate", html },
      "interactive",
    )) as DesignValidationReport;
    const validation = validationFromReport(report);
    if (report.overElementLimit)
      throw new DesignError(
        "invalid-content",
        `Frame exceeds 5000 elements (${report.elementCount}); the previous version was kept`,
        { retry: "never", details: { elements: report.elementCount } },
      );
    return validation;
  } catch (error) {
    if (isDesignError(error, "renderer-unavailable")) return unavailableValidation();
    throw error;
  }
}

function change(
  base: DesignFrame | null,
  next: DesignFrame | null,
  fields: DesignFrameChangeField[],
  extra: Partial<FrameChange> = {},
): FrameChange {
  return { frameId: (next ?? base)!.id, base, next, fields, ...extra };
}

function geometryFields(
  before: DesignFrame,
  after: Partial<DesignFrame>,
): DesignFrameChangeField[] {
  const fields = new Set<DesignFrameChangeField>();
  if (after.name !== undefined && after.name !== before.name) fields.add("name");
  if (
    (after.x !== undefined && after.x !== before.x) ||
    (after.y !== undefined && after.y !== before.y)
  )
    fields.add("geometry");
  if (
    (after.width !== undefined && after.width !== before.width) ||
    (after.height !== undefined && after.height !== before.height)
  )
    fields.add("viewport");
  return Array.from(fields);
}

function empty(): ComputedOperation {
  return { noop: false, frames: [], frameRevisions: [], structureChecks: [], validateAfter: [] };
}

/**
 * Computes an operation from an immutable snapshot. Expensive DOM work happens
 * here, outside every lock; `applyComputed` re-verifies before committing.
 */
export async function computeOperation(ctx: ComputeContext): Promise<ComputedOperation> {
  const { record, descriptor } = ctx;
  const input = descriptor.input;
  const target = { canvasId: record.canvasId };
  const result = empty();
  switch (input.kind) {
    case "rename_canvas": {
      result.canvasRevision = requireRevision(
        descriptor.preconditions.canvasRevision,
        record.document.revision,
        "canvas",
        target,
      );
      if (input.name.trim() === record.document.name) return { ...result, noop: true };
      result.canvasName = { before: record.document.name, after: input.name.trim() };
      result.history = { kind: input.kind, label: historyLabel(input.kind, []), scope: "canvas" };
      return result;
    }
    case "create_frame": {
      result.canvasRevision = requireRevision(
        descriptor.preconditions.canvasRevision,
        record.document.revision,
        "canvas",
        target,
      );
      if (record.document.frames.length >= DESIGN_MAX_FRAMES)
        throw new DesignError("capacity", `Frame limit reached (${DESIGN_MAX_FRAMES})`, {
          retry: "never",
        });
      const validation = await validateRaw(ctx, input.frame.html, input.frame);
      const frame = frameSchema.parse({ ...input.frame, id: randomUUID(), revision: 0 });
      result.frames.push(
        change(null, frame, ["name", "geometry", "viewport", "content", "structure"], {
          index: record.document.frames.length,
          validation,
        }),
      );
      result.history = {
        kind: input.kind,
        label: historyLabel(input.kind, [frame.name]),
        scope: "frame",
      };
      return result;
    }
    case "batch":
      return computeBatch(ctx, input.operations);
    case "undo":
    case "redo":
      return computeHistory(ctx, input.kind, input.scope ?? "own");
    case "restore_checkpoint":
      return computeRestore(ctx, input.entryId, input.side);
    case "create_canvas":
    case "duplicate_canvas":
    case "delete_canvas":
    case "restore_canvas":
      throw new DesignError("unsupported", "Canvas lifecycle operations are executed separately");
    default:
      return computeFrameOperation(ctx, input);
  }
}

async function computeFrameOperation(
  ctx: ComputeContext,
  input: Extract<DesignOperationInput, { frameId: string }>,
): Promise<ComputedOperation> {
  const { record, descriptor } = ctx;
  const frame = frameOf(record, input.frameId);
  const target = { canvasId: record.canvasId, frameId: frame.id };
  const expected = ctx.frameRevision ?? descriptor.preconditions.frameRevision;
  requireRevision(expected, frame.revision, "frame", target);
  const result = empty();
  result.frameRevisions.push({ frameId: frame.id, revision: frame.revision });
  const meta = record.frames[frame.id];
  if (descriptor.preconditions.structureId !== undefined) {
    if (!meta || meta.structureId !== descriptor.preconditions.structureId)
      throw new DesignError("conflict", "The frame structure changed; reselect the element", {
        target,
        retry: "after-refresh",
      });
    result.structureChecks.push({ frameId: frame.id, structureId: meta.structureId });
  }
  const label = historyLabel(input.kind, [frame.name]);
  result.history = { kind: input.kind, label, scope: "frame" };
  switch (input.kind) {
    case "update_frame": {
      const next = frameSchema.parse({ ...frame, ...input.patch, id: frame.id });
      const fields = geometryFields(frame, input.patch);
      if (!fields.length) return { ...result, noop: true, history: undefined };
      result.frames.push(change(frame, next, fields));
      return result;
    }
    case "replace_frame_html": {
      if (input.html === frame.html) return { ...result, noop: true, history: undefined };
      const validation = await validateRaw(ctx, input.html, frame);
      result.frames.push(
        change(frame, { ...frame, html: input.html }, ["content", "structure"], { validation }),
      );
      return result;
    }
    case "set_element_styles": {
      if (meta?.validation.state === "invalid")
        throw new DesignError(
          "invalid-content",
          "Repair or replace this frame before editing elements",
        );
      const styled = (await ctx.render(
        frame,
        { op: "applyStyles", selector: input.selector, styles: input.styles },
        "interactive",
      )) as DesignStyleResult;
      if (styled.invalid.length)
        throw new DesignError(
          "invalid-input",
          `The browser rejected these CSS values; nothing was applied: ${styled.invalid.join(", ")}`,
          { retry: "never", details: { properties: styled.invalid.slice(0, 64) } },
        );
      if (!styled.html || styled.html === frame.html)
        return {
          ...result,
          noop: true,
          history: undefined,
          unchangedProperties: styled.unchanged,
        };
      result.unchangedProperties = styled.unchanged;
      result.frames.push(
        change(frame, frameSchema.parse({ ...frame, html: styled.html }), ["content"], {
          preserveStructure: true,
          carryValidation: true,
        }),
      );
      return result;
    }
    case "append_frame_html":
    case "replace_element_html":
    case "move_element": {
      if (meta?.validation.state === "invalid")
        throw new DesignError(
          "invalid-content",
          "Repair or replace this frame before editing elements",
        );
      const operation: DesignOperation =
        input.kind === "append_frame_html"
          ? { op: "appendHtml", html: input.html }
          : input.kind === "replace_element_html"
            ? { op: "replaceElementHtml", selector: input.selector, html: input.html }
            : {
                op: "moveElement",
                selector: input.selector,
                parentSelector: input.parentSelector,
                ...(input.beforeSelector ? { beforeSelector: input.beforeSelector } : {}),
              };
      const html = (await ctx.render(frame, operation, "interactive")) as string;
      if (html === frame.html) return { ...result, noop: true, history: undefined };
      result.frames.push(
        change(frame, frameSchema.parse({ ...frame, html }), ["content", "structure"]),
      );
      result.validateAfter.push(frame.id);
      return result;
    }
    case "duplicate_frame": {
      if (descriptor.preconditions.canvasRevision !== undefined) {
        result.canvasRevision = requireRevision(
          descriptor.preconditions.canvasRevision,
          record.document.revision,
          "canvas",
          { canvasId: record.canvasId },
        );
      }
      if (record.document.frames.length >= DESIGN_MAX_FRAMES)
        throw new DesignError("capacity", `Frame limit reached (${DESIGN_MAX_FRAMES})`, {
          retry: "never",
        });
      const copy = frameSchema.parse({
        ...frame,
        id: randomUUID(),
        name: (input.name ?? `${frame.name} copy`).slice(0, 120),
        x: input.x ?? Math.min(100_000, frame.x + frame.width + 40),
        y: input.y ?? frame.y,
        revision: 0,
      });
      result.frames.push(
        change(null, copy, ["name", "geometry", "viewport", "content", "structure"], {
          index: record.document.frames.indexOf(frame) + 1,
          validation: meta?.validation
            ? {
                runtimeVersion: meta.validation.runtimeVersion,
                state: meta.validation.state,
                reasons: meta.validation.reasons,
                truncated: meta.validation.truncated,
                ...(meta.validation.message ? { message: meta.validation.message } : {}),
              }
            : undefined,
        }),
      );
      result.history = {
        kind: input.kind,
        label: historyLabel(input.kind, [frame.name]),
        scope: "frame",
      };
      return result;
    }
    case "delete_frame": {
      if (descriptor.preconditions.canvasRevision !== undefined)
        result.canvasRevision = requireRevision(
          descriptor.preconditions.canvasRevision,
          record.document.revision,
          "canvas",
          { canvasId: record.canvasId },
        );
      result.frames.push(
        change(frame, null, ["name", "geometry", "viewport", "content", "structure"], {
          index: record.document.frames.indexOf(frame),
        }),
      );
      return result;
    }
  }
}

async function computeBatch(
  ctx: ComputeContext,
  operations: DesignBatchableInput[],
): Promise<ComputedOperation> {
  const { record, descriptor } = ctx;
  const result = empty();
  result.canvasRevision = requireRevision(
    descriptor.preconditions.canvasRevision,
    record.document.revision,
    "canvas",
    { canvasId: record.canvasId },
  );
  const bytes = Buffer.byteLength(JSON.stringify(operations));
  if (bytes > 512 * 1024)
    throw new DesignError("capacity", "Batch exceeds 512 KiB", { retry: "never" });
  const working = new Map(record.document.frames.map((frame) => [frame.id, { ...frame }]));
  const order = record.document.frames.map((frame) => frame.id);
  const baseById = new Map(record.document.frames.map((frame) => [frame.id, frame]));
  const touched = new Map<string, FrameChange>();
  const structural = new Set<string>();
  let name = record.document.name;
  const outcomes: NonNullable<DesignOperationResult["outcomes"]> = [];
  const touch = (
    frameId: string,
    fields: DesignFrameChangeField[],
    extra: Partial<FrameChange> = {},
  ) => {
    const existing = touched.get(frameId);
    const next = working.get(frameId) ?? null;
    if (existing) {
      existing.next = next ? { ...next } : null;
      existing.fields = Array.from(new Set([...existing.fields, ...fields]));
      if (extra.validation) existing.validation = extra.validation;
      if (existing.preserveStructure && !extra.preserveStructure)
        existing.preserveStructure = false;
      if (existing.carryValidation && !extra.carryValidation) existing.carryValidation = false;
      if (extra.index !== undefined) existing.index = extra.index;
    } else {
      touched.set(frameId, {
        frameId,
        base: baseById.get(frameId) ?? null,
        next: next ? { ...next } : null,
        fields,
        ...extra,
      });
    }
  };
  for (const operation of operations) {
    switch (operation.kind) {
      case "rename_canvas":
        outcomes.push({ kind: operation.kind, changed: operation.name.trim() !== name });
        name = operation.name.trim();
        break;
      case "create_frame": {
        if (working.size >= DESIGN_MAX_FRAMES)
          throw new DesignError("capacity", `Frame limit reached (${DESIGN_MAX_FRAMES})`, {
            retry: "never",
          });
        const validation = await validateRaw(ctx, operation.frame.html, operation.frame);
        const frame = frameSchema.parse({ ...operation.frame, id: randomUUID(), revision: 0 });
        working.set(frame.id, frame);
        order.push(frame.id);
        structural.add(frame.id);
        touch(frame.id, ["name", "geometry", "viewport", "content", "structure"], {
          validation,
          index: order.length - 1,
        });
        outcomes.push({ kind: operation.kind, changed: true, frameId: frame.id });
        break;
      }
      case "update_frame": {
        const frame = working.get(operation.frameId);
        if (!frame) throw new DesignError("not-found", "Frame not found in batch");
        const next = frameSchema.parse({ ...frame, ...operation.patch, id: frame.id });
        const fields = geometryFields(frame, operation.patch);
        working.set(frame.id, next);
        if (fields.length) touch(frame.id, fields);
        outcomes.push({ kind: operation.kind, changed: fields.length > 0, frameId: frame.id });
        break;
      }
      case "replace_frame_html": {
        const frame = working.get(operation.frameId);
        if (!frame) throw new DesignError("not-found", "Frame not found in batch");
        const changed = frame.html !== operation.html;
        if (changed) {
          const validation = await validateRaw(ctx, operation.html, frame);
          working.set(frame.id, { ...frame, html: operation.html });
          structural.add(frame.id);
          touch(frame.id, ["content", "structure"], { validation });
        }
        outcomes.push({ kind: operation.kind, changed, frameId: frame.id });
        break;
      }
      case "set_element_styles": {
        const frame = working.get(operation.frameId);
        if (!frame) throw new DesignError("not-found", "Frame not found in batch");
        if (structural.has(frame.id))
          throw new DesignError(
            "invalid-input",
            "A batch cannot target elements after replacing or creating the same frame",
            { retry: "never" },
          );
        const styled = (await ctx.render(
          frame,
          { op: "applyStyles", selector: operation.selector, styles: operation.styles },
          "interactive",
        )) as DesignStyleResult;
        if (styled.invalid.length)
          throw new DesignError(
            "invalid-input",
            `The browser rejected these CSS values; nothing was applied: ${styled.invalid.join(", ")}`,
            { retry: "never", details: { properties: styled.invalid.slice(0, 64) } },
          );
        const changed = Boolean(styled.html) && styled.html !== frame.html;
        if (changed) {
          working.set(frame.id, { ...frame, html: styled.html });
          touch(frame.id, ["content"], { preserveStructure: true, carryValidation: true });
        }
        outcomes.push({ kind: operation.kind, changed, frameId: frame.id });
        break;
      }
      case "delete_frame": {
        if (!working.has(operation.frameId))
          throw new DesignError("not-found", "Frame not found in batch");
        const index = order.indexOf(operation.frameId);
        working.delete(operation.frameId);
        order.splice(index, 1);
        touch(operation.frameId, ["name", "geometry", "viewport", "content", "structure"], {
          index,
        });
        outcomes.push({ kind: operation.kind, changed: true, frameId: operation.frameId });
        break;
      }
    }
  }
  result.outcomes = outcomes;
  for (const entry of touched.values()) {
    // Created-then-deleted frames within one batch never existed outside it.
    if (!entry.base && !entry.next) continue;
    if (entry.next && entry.base) {
      const same =
        entry.next.name === entry.base.name &&
        entry.next.x === entry.base.x &&
        entry.next.y === entry.base.y &&
        entry.next.width === entry.base.width &&
        entry.next.height === entry.base.height &&
        entry.next.html === entry.base.html;
      if (same) continue;
    }
    if (entry.next && !entry.base) entry.index = order.indexOf(entry.frameId);
    result.frames.push(entry);
    if (entry.base)
      result.frameRevisions.push({ frameId: entry.frameId, revision: entry.base.revision });
  }
  if (name !== record.document.name)
    result.canvasName = { before: record.document.name, after: name };
  if (!result.frames.length && !result.canvasName) return { ...result, noop: true };
  result.history = {
    kind: "batch",
    label: historyLabel(
      "batch",
      result.frames.map((entry) => (entry.next ?? entry.base)!.name),
    ),
    scope: result.canvasName ? "canvas" : "frame",
  };
  return result;
}

function restoreChanges(
  record: DesignPrivateRecord,
  checkpoint: DesignCheckpoint,
  side: "before" | "after",
): FrameChange[] {
  const current = new Map(record.document.frames.map((frame) => [frame.id, frame]));
  const changes: FrameChange[] = [];
  for (const frame of checkpoint.frames) {
    const now = current.get(frame.frameId) ?? null;
    const wanted = side === "before" ? frame.before : frame.after;
    const index = side === "before" ? frame.beforeIndex : frame.afterIndex;
    if (!wanted && !now) continue;
    if (!wanted) {
      changes.push(change(now, null, ["name", "geometry", "viewport", "content", "structure"]));
      continue;
    }
    const next: DesignFrame = { ...wanted, revision: now?.revision ?? wanted.revision };
    const fields: DesignFrameChangeField[] = now
      ? [
          ...geometryFields(now, wanted),
          ...(now.html !== wanted.html ? (["content", "structure"] as const) : []),
        ]
      : ["name", "geometry", "viewport", "content", "structure"];
    if (!fields.length) continue;
    changes.push(
      change(now, next, fields, now ? {} : { index: index ?? record.document.frames.length }),
    );
  }
  return changes;
}

async function computeHistory(
  ctx: ComputeContext,
  kind: "undo" | "redo",
  scope: "own" | "any",
): Promise<ComputedOperation> {
  const { record, descriptor, actor } = ctx;
  if (descriptor.preconditions.canvasRevision !== undefined)
    requireRevision(descriptor.preconditions.canvasRevision, record.document.revision, "canvas", {
      canvasId: record.canvasId,
    });
  const entry =
    kind === "undo" ? undoCandidate(record, actor, scope) : redoCandidate(record, actor, scope);
  if (!entry) throw new DesignError("history-ineligible", `Nothing to ${kind}`, { retry: "never" });
  const check = eligibility(record, entry);
  if (!check.eligible)
    throw new DesignError("history-ineligible", `Cannot ${kind}: ${check.reason}`, {
      retry: "review",
      details: { entryId: entry.id },
    });
  const checkpoint = await readCheckpoint(ctx.store, record.canvasId, entry);
  const result = empty();
  result.frames = restoreChanges(record, checkpoint, "before");
  for (const frame of entry.frames) {
    const now = record.document.frames.find((candidate) => candidate.id === frame.frameId);
    if (now) result.frameRevisions.push({ frameId: now.id, revision: now.revision });
  }
  if (entry.scope === "canvas" || descriptor.preconditions.canvasRevision !== undefined)
    result.canvasRevision = record.document.revision;
  if (checkpoint.canvasName)
    result.canvasName = { before: record.document.name, after: checkpoint.canvasName.before };
  if (
    !result.frames.length &&
    (!result.canvasName || result.canvasName.after === record.document.name)
  )
    result.canvasName = undefined;
  const target =
    kind === "undo"
      ? entry
      : record.history.entries.find((candidate) => candidate.id === entry.undoOf);
  result.history = {
    kind: kind === "undo" ? "undo" : (target?.kind ?? "redo"),
    label:
      kind === "undo"
        ? `Undo ${entry.label}`
        : (target?.label ?? entry.label.replace(/^Undo /, "")),
    scope: entry.scope,
    ...(kind === "undo"
      ? { undoOf: entry.id, markUndone: entry.id }
      : { redoOf: entry.undoOf, markUndone: entry.id }),
  };
  return result;
}

async function computeRestore(
  ctx: ComputeContext,
  entryId: string,
  side: "before" | "after",
): Promise<ComputedOperation> {
  const { record, descriptor } = ctx;
  const result = empty();
  result.canvasRevision = requireRevision(
    descriptor.preconditions.canvasRevision,
    record.document.revision,
    "canvas",
    { canvasId: record.canvasId },
  );
  const entry = record.history.entries.find((candidate) => candidate.id === entryId);
  if (!entry) throw new DesignError("not-found", "History entry not found");
  const checkpoint = await readCheckpoint(ctx.store, record.canvasId, entry);
  result.frames = restoreChanges(record, checkpoint, side);
  const restoring = result.frames.filter((frame) => !frame.base && frame.next).length;
  if (record.document.frames.length + restoring > DESIGN_MAX_FRAMES)
    throw new DesignError("capacity", `Frame limit reached (${DESIGN_MAX_FRAMES})`, {
      retry: "never",
    });
  if (checkpoint.canvasName) {
    const wanted = side === "before" ? checkpoint.canvasName.before : checkpoint.canvasName.after;
    if (wanted !== record.document.name)
      result.canvasName = { before: record.document.name, after: wanted };
  }
  if (!result.frames.length && !result.canvasName) return { ...result, noop: true };
  result.history = {
    kind: "restore_checkpoint",
    label: `Restore ${side === "before" ? "before" : "after"} “${entry.label.slice(0, 60)}”`,
    scope: result.canvasName ? "canvas" : "frame",
  };
  return result;
}

export function isHtmlOperation(kind: string) {
  return HTML_OPS.has(kind);
}
