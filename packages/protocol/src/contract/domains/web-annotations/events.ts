/** `web-annotations` events. Browser-safe. */
import * as Schema from "effect/Schema";
import { WEB_ANNOTATIONS_CHANGED_EVENT } from "../../../web-annotations.js";
import { defineEvent } from "../../event.js";
import { webAnnotationsDomain } from "./domain.js";

/** A committed annotation change (`WebAnnotationChangeHint`). */
export const webAnnotationsChangedEvent = defineEvent({
  domain: webAnnotationsDomain,
  name: WEB_ANNOTATIONS_CHANGED_EVENT,
  payload: Schema.Struct({
    environmentId: Schema.String,
    generation: Schema.String,
    revision: Schema.Finite,
    annotationIds: Schema.Array(Schema.String),
    requestIds: Schema.Array(Schema.String),
    reset: Schema.Boolean,
  }),
});

export const WEB_ANNOTATIONS_EVENTS = [webAnnotationsChangedEvent] as const;
