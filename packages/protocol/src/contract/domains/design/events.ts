/** `design` events. Browser-safe. */
import * as Schema from "effect/Schema";
import { DESIGN_EVENT } from "../../../design-canvas.js";
import { defineEvent } from "../../event.js";
import { designDomain } from "./domain.js";

/**
 * A content-free canvas hint (`DesignChange` plus the service generation,
 * which older backends do not send).
 */
export const designCanvasChangedEvent = defineEvent({
  domain: designDomain,
  name: DESIGN_EVENT,
  payload: Schema.Struct({
    canvasId: Schema.String,
    revision: Schema.Finite,
    generation: Schema.optional(Schema.String),
    frameId: Schema.optional(Schema.String),
    kind: Schema.optional(Schema.String),
    statusVersion: Schema.optional(Schema.Finite),
    intents: Schema.optional(Schema.Boolean),
  }),
});

export const DESIGN_EVENTS = [designCanvasChangedEvent] as const;
