/** `agent-servers` events. Browser-safe. */
import * as Schema from "effect/Schema";
import { defineEvent } from "../../event.js";
import { agentServersDomain } from "./domain.js";

/** An environment's Claude model catalog snapshot (`ClaudeModelCatalogSnapshot`). */
export const claudeModelCatalogUpdatedEvent = defineEvent({
  domain: agentServersDomain,
  name: "claude-model-catalog-updated",
  payload: Schema.Struct({
    environmentId: Schema.String,
    models: Schema.Array(Schema.ObjectKeyword),
    source: Schema.String,
    fetchedAt: Schema.String,
    stale: Schema.Boolean,
    sdkVersion: Schema.optional(Schema.String),
    cliVersion: Schema.optional(Schema.String),
    error: Schema.optional(Schema.String),
  }),
});

export const AGENT_SERVERS_EVENTS = [claudeModelCatalogUpdatedEvent] as const;
