/** `previews` events. Browser-safe. */
import * as Schema from "effect/Schema";
import { PREVIEW_SERVICES_CHANGED_EVENT } from "../../../preview-services.js";
import { defineEvent } from "../../event.js";
import { previewsDomain } from "./domain.js";

/** The preview service registry changed (`PreviewServicesChangedEvent`). */
export const previewServicesChangedEvent = defineEvent({
  domain: previewsDomain,
  name: PREVIEW_SERVICES_CHANGED_EVENT,
  payload: Schema.Struct({
    backendInstanceId: Schema.String,
    backendEpoch: Schema.String,
    registryRevision: Schema.Finite,
    environmentIds: Schema.Array(Schema.String),
    revokedServiceIds: Schema.Array(Schema.String),
  }),
});

export const PREVIEWS_EVENTS = [previewServicesChangedEvent] as const;
