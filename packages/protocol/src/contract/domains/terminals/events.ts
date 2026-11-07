/** `terminals` events. Browser-safe. */
import * as Schema from "effect/Schema";
import { defineEventFamily } from "../../event.js";
import { terminalsDomain } from "./domain.js";

/**
 * `terminal-output-<sessionId>`: output of one terminal session. A PTY sends
 * `{ text, revision, generation }`; a tmux interactive pane sends
 * `{ text, full }` (`full`: the text replaces the screen). Droppable under
 * backpressure, never replayed (invariant 5).
 */
export const terminalOutputEvents = defineEventFamily({
  domain: terminalsDomain,
  prefix: "terminal-output-",
  payload: Schema.Struct({
    text: Schema.String,
    revision: Schema.optional(Schema.Finite),
    generation: Schema.optional(Schema.Finite),
    full: Schema.optional(Schema.Boolean),
  }),
});

export const TERMINALS_EVENTS = [terminalOutputEvents] as const;
