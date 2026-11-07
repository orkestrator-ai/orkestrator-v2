import { Schema } from "effect";
import { int, list, num, record, refine, str, strictObject, withDefault } from "../tool-schema.js";
import {
  DESIGN_MAX_COORDINATE,
  DESIGN_MAX_FRAME_SIZE,
  DESIGN_MAX_FRAMES,
  DESIGN_MAX_HTML_BYTES,
  DESIGN_MIN_FRAME_SIZE,
} from "@orkestrator/protocol/design-canvas";
import { DESIGN_LIMITS } from "@orkestrator/protocol/design-operations";

/** Portable version-1 schemas. Strict: private fields can never leak in. */
export const designId = str({ uuid: true });
export const designName = str({ trim: true, min: 1, max: 120 });
export const revision = int({ min: 0, max: Number.MAX_SAFE_INTEGER - 1 });
export const htmlSchema = Schema.String.check(
  refine((value) => Buffer.byteLength(value) <= DESIGN_MAX_HTML_BYTES, "HTML exceeds 256 KiB"),
);
export const coordinate = num({ min: -DESIGN_MAX_COORDINATE, max: DESIGN_MAX_COORDINATE });
export const dimension = int({ min: DESIGN_MIN_FRAME_SIZE, max: DESIGN_MAX_FRAME_SIZE });
export const frameSchema = strictObject({
  id: designId,
  name: designName,
  x: coordinate,
  y: coordinate,
  width: dimension,
  height: dimension,
  html: htmlSchema,
  revision,
});
export const canvasSchema = strictObject({
  format: Schema.Literal("orkdes"),
  version: Schema.Literal(1),
  id: designId,
  environmentId: str({ min: 1, max: 256 }),
  name: designName,
  revision,
  frames: list(frameSchema, { max: DESIGN_MAX_FRAMES }),
}).check(
  refine(
    (value) => new Set(value.frames.map((frame) => frame.id)).size === value.frames.length,
    "Duplicate frame ids",
  ),
);

export const selectorSchema = str({ min: 1, max: 2048 });
export const stylesSchema = record(str({ min: 1, max: 100 }), Schema.NullOr(str({ max: 2048 })))
  .check(refine((value) => Object.keys(value).length <= 64, "Too many styles"))
  .check(refine((value) => Object.keys(value).length > 0, "No styles"));
export const frameInputSchema = strictObject({
  name: designName,
  x: coordinate,
  y: coordinate,
  width: dimension,
  height: dimension,
  html: htmlSchema,
});
export const geometryPatchSchema = strictObject({
  name: Schema.optionalKey(designName),
  x: Schema.optionalKey(coordinate),
  y: Schema.optionalKey(coordinate),
  width: Schema.optionalKey(dimension),
  height: Schema.optionalKey(dimension),
}).check(refine((value) => Object.keys(value).length > 0, "Empty frame patch"));

const batchable = Schema.Union([
  strictObject({ kind: Schema.Literal("create_frame"), frame: frameInputSchema }),
  strictObject({
    kind: Schema.Literal("update_frame"),
    frameId: designId,
    patch: geometryPatchSchema,
  }),
  strictObject({ kind: Schema.Literal("replace_frame_html"), frameId: designId, html: htmlSchema }),
  strictObject({
    kind: Schema.Literal("set_element_styles"),
    frameId: designId,
    selector: selectorSchema,
    styles: stylesSchema,
  }),
  strictObject({ kind: Schema.Literal("delete_frame"), frameId: designId }),
  strictObject({ kind: Schema.Literal("rename_canvas"), name: designName }),
]);

export const operationInputSchema = Schema.Union([
  strictObject({
    kind: Schema.Literal("create_canvas"),
    name: designName,
    document: Schema.optionalKey(str({ max: 4 * 1024 * 1024 + 1024 })),
  }),
  strictObject({ kind: Schema.Literal("rename_canvas"), name: designName }),
  strictObject({ kind: Schema.Literal("duplicate_canvas"), name: Schema.optionalKey(designName) }),
  strictObject({ kind: Schema.Literal("delete_canvas") }),
  strictObject({ kind: Schema.Literal("restore_canvas") }),
  strictObject({ kind: Schema.Literal("create_frame"), frame: frameInputSchema }),
  strictObject({
    kind: Schema.Literal("update_frame"),
    frameId: designId,
    patch: geometryPatchSchema,
  }),
  strictObject({ kind: Schema.Literal("replace_frame_html"), frameId: designId, html: htmlSchema }),
  strictObject({ kind: Schema.Literal("append_frame_html"), frameId: designId, html: htmlSchema }),
  strictObject({
    kind: Schema.Literal("set_element_styles"),
    frameId: designId,
    selector: selectorSchema,
    styles: stylesSchema,
  }),
  strictObject({
    kind: Schema.Literal("replace_element_html"),
    frameId: designId,
    selector: selectorSchema,
    html: htmlSchema,
  }),
  strictObject({
    kind: Schema.Literal("move_element"),
    frameId: designId,
    selector: selectorSchema,
    parentSelector: selectorSchema,
    beforeSelector: Schema.optionalKey(selectorSchema),
  }),
  strictObject({
    kind: Schema.Literal("duplicate_frame"),
    frameId: designId,
    name: Schema.optionalKey(designName),
    x: Schema.optionalKey(coordinate),
    y: Schema.optionalKey(coordinate),
  }),
  strictObject({ kind: Schema.Literal("delete_frame"), frameId: designId }),
  strictObject({
    kind: Schema.Literal("undo"),
    scope: Schema.optionalKey(Schema.Literals(["own", "any"])),
  }),
  strictObject({
    kind: Schema.Literal("redo"),
    scope: Schema.optionalKey(Schema.Literals(["own", "any"])),
  }),
  strictObject({
    kind: Schema.Literal("restore_checkpoint"),
    entryId: str({ min: 1, max: 64 }),
    side: Schema.Literals(["before", "after"]),
  }),
  strictObject({
    kind: Schema.Literal("batch"),
    operations: list(batchable, { min: 1, max: DESIGN_LIMITS.batchOperations }),
  }),
]);

export const preconditionsSchema = strictObject({
  canvasRevision: Schema.optionalKey(revision),
  frameRevision: Schema.optionalKey(revision),
  structureId: Schema.optionalKey(str({ min: 1, max: 64 })),
  tombstoneRevision: Schema.optionalKey(revision),
});

const opaqueId = str({ min: 1, max: 100, pattern: /^[a-zA-Z0-9._:-]+$/ });

export const descriptorSchema = strictObject({
  canvasId: Schema.optionalKey(designId),
  input: operationInputSchema,
  preconditions: withDefault(preconditionsSchema, {}),
  predecessor: Schema.optionalKey(opaqueId),
  gestureId: Schema.optionalKey(opaqueId),
  clientId: Schema.optionalKey(opaqueId),
  correlationId: Schema.optionalKey(opaqueId),
});

export const operationToken = str({ pattern: /^op_[a-f0-9-]{36}$/ });
