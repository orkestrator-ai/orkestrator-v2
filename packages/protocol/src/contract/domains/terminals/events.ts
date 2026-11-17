/** `terminals` events. Browser-safe. */
import * as Schema from "effect/Schema";
import { defineEventFamily } from "../../event.js";
import { terminalsDomain } from "./domain.js";

/**
 * `terminal-output-<sessionId>`: output of one terminal session. A PTY sends
 * `{ text, revision, generation }`; a tmux interactive pane sends
 * `{ text, full }` (`full`: the text replaces the screen). Droppable under
 * backpressure, never replayed (invariant 5). A desync notice carries empty
 * text and asks the client to recover its snapshot and attached streams.
 */
export const terminalOutputEvents = defineEventFamily({
  domain: terminalsDomain,
  prefix: "terminal-output-",
  payload: Schema.Struct({
    text: Schema.String,
    desynced: Schema.optional(Schema.Boolean),
    revision: Schema.optional(Schema.Finite),
    generation: Schema.optional(Schema.Finite),
    full: Schema.optional(Schema.Boolean),
  }),
});

export const TERMINALS_EVENTS = [terminalOutputEvents] as const;
