import { z } from "zod";
import {
  DESIGN_MAX_COORDINATE,
  DESIGN_MAX_FRAME_SIZE,
  DESIGN_MAX_FRAMES,
  DESIGN_MAX_HTML_BYTES,
  DESIGN_MIN_FRAME_SIZE,
} from "@orkestrator/protocol/design-canvas";
import { DESIGN_LIMITS } from "@orkestrator/protocol/design-operations";

/** Portable version-1 schemas. Strict: private fields can never leak in. */
export const designId = z.string().uuid();
export const designName = z.string().trim().min(1).max(120);
export const revision = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
export const htmlSchema = z
  .string()
  .refine((value) => Buffer.byteLength(value) <= DESIGN_MAX_HTML_BYTES, "HTML exceeds 256 KiB");
export const coordinate = z
  .number()
  .finite()
  .min(-DESIGN_MAX_COORDINATE)
  .max(DESIGN_MAX_COORDINATE);
export const dimension = z.number().int().min(DESIGN_MIN_FRAME_SIZE).max(DESIGN_MAX_FRAME_SIZE);
export const frameSchema = z
  .object({
    id: designId,
    name: designName,
    x: coordinate,
    y: coordinate,
    width: dimension,
    height: dimension,
    html: htmlSchema,
    revision,
  })
  .strict();
export const canvasSchema = z
  .object({
    format: z.literal("orkdes"),
    version: z.literal(1),
    id: designId,
    environmentId: z.string().min(1).max(256),
    name: designName,
    revision,
    frames: z.array(frameSchema).max(DESIGN_MAX_FRAMES),
  })
  .strict()
  .refine(
    (value) => new Set(value.frames.map((frame) => frame.id)).size === value.frames.length,
    "Duplicate frame ids",
  );

export const selectorSchema = z.string().min(1).max(2048);
export const stylesSchema = z
  .record(z.string().min(1).max(100), z.string().max(2048).nullable())
  .refine((value) => Object.keys(value).length <= 64, "Too many styles")
  .refine((value) => Object.keys(value).length > 0, "No styles");
export const frameInputSchema = z
  .object({
    name: designName,
    x: coordinate,
    y: coordinate,
    width: dimension,
    height: dimension,
    html: htmlSchema,
  })
  .strict();
export const geometryPatchSchema = z
  .object({
    name: designName.optional(),
    x: coordinate.optional(),
    y: coordinate.optional(),
    width: dimension.optional(),
    height: dimension.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Empty frame patch");

const batchable = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create_frame"), frame: frameInputSchema }).strict(),
  z
    .object({ kind: z.literal("update_frame"), frameId: designId, patch: geometryPatchSchema })
    .strict(),
  z.object({ kind: z.literal("replace_frame_html"), frameId: designId, html: htmlSchema }).strict(),
  z
    .object({
      kind: z.literal("set_element_styles"),
      frameId: designId,
      selector: selectorSchema,
      styles: stylesSchema,
    })
    .strict(),
  z.object({ kind: z.literal("delete_frame"), frameId: designId }).strict(),
  z.object({ kind: z.literal("rename_canvas"), name: designName }).strict(),
]);

export const operationInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("create_canvas"),
      name: designName,
      document: z
        .string()
        .max(4 * 1024 * 1024 + 1024)
        .optional(),
    })
    .strict(),
  z.object({ kind: z.literal("rename_canvas"), name: designName }).strict(),
  z.object({ kind: z.literal("duplicate_canvas"), name: designName.optional() }).strict(),
  z.object({ kind: z.literal("delete_canvas") }).strict(),
  z.object({ kind: z.literal("restore_canvas") }).strict(),
  z.object({ kind: z.literal("create_frame"), frame: frameInputSchema }).strict(),
  z
    .object({ kind: z.literal("update_frame"), frameId: designId, patch: geometryPatchSchema })
    .strict(),
  z.object({ kind: z.literal("replace_frame_html"), frameId: designId, html: htmlSchema }).strict(),
  z.object({ kind: z.literal("append_frame_html"), frameId: designId, html: htmlSchema }).strict(),
  z
    .object({
      kind: z.literal("set_element_styles"),
      frameId: designId,
      selector: selectorSchema,
      styles: stylesSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("replace_element_html"),
      frameId: designId,
      selector: selectorSchema,
      html: htmlSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("move_element"),
      frameId: designId,
      selector: selectorSchema,
      parentSelector: selectorSchema,
      beforeSelector: selectorSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("duplicate_frame"),
      frameId: designId,
      name: designName.optional(),
      x: coordinate.optional(),
      y: coordinate.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("delete_frame"), frameId: designId }).strict(),
  z.object({ kind: z.literal("undo"), scope: z.enum(["own", "any"]).optional() }).strict(),
  z.object({ kind: z.literal("redo"), scope: z.enum(["own", "any"]).optional() }).strict(),
  z
    .object({
      kind: z.literal("restore_checkpoint"),
      entryId: z.string().min(1).max(64),
      side: z.enum(["before", "after"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("batch"),
      operations: z.array(batchable).min(1).max(DESIGN_LIMITS.batchOperations),
    })
    .strict(),
]);

export const preconditionsSchema = z
  .object({
    canvasRevision: revision.optional(),
    frameRevision: revision.optional(),
    structureId: z.string().min(1).max(64).optional(),
    tombstoneRevision: revision.optional(),
  })
  .strict();

const opaqueId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9._:-]+$/);

export const descriptorSchema = z
  .object({
    canvasId: designId.optional(),
    input: operationInputSchema,
    preconditions: preconditionsSchema.default({}),
    predecessor: opaqueId.optional(),
    gestureId: opaqueId.optional(),
    clientId: opaqueId.optional(),
    correlationId: opaqueId.optional(),
  })
  .strict();

export const operationToken = z.string().regex(/^op_[a-f0-9-]{36}$/);
