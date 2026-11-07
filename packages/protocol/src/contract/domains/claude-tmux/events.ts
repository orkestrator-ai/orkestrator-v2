/**
 * `claude-tmux` events: the tmux-hosted Claude session stream, its usage and
 * prompt observations, and the per-container state family. Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineEvent, defineEventFamily } from "../../event.js";
import { claudeTmuxDomain } from "./domain.js";

const tmuxFrame = {
  tab_id: Schema.String,
  environment_id: Schema.String,
};
const sessionFrame = { ...tmuxFrame, session_id: Schema.String };

/**
 * Every frame of a tmux-hosted Claude session, discriminated by `kind`. A
 * kind this build does not know fails the union, so a typed listener skips
 * it, as today's `switch` over `kind` does.
 */
export const claudeTmuxEvent = defineEvent({
  domain: claudeTmuxDomain,
  name: "claude-tmux:event",
  payload: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("observation"),
      ...sessionFrame,
      observation: Schema.ObjectKeyword,
    }),
    Schema.Struct({
      kind: Schema.Literal("started"),
      ...sessionFrame,
      observation_generation: Schema.optional(Schema.String),
      resumed: Schema.Boolean,
      fast_mode: Schema.NullOr(Schema.Boolean),
    }),
    Schema.Struct({ kind: Schema.Literal("initial-prompt-sent"), ...sessionFrame }),
    Schema.Struct({
      kind: Schema.Literal("permission-mode-changed"),
      ...sessionFrame,
      permission_mode: Schema.String,
    }),
    Schema.Struct({
      kind: Schema.Literal("fast-mode-changed"),
      ...sessionFrame,
      fast_mode: Schema.Boolean,
    }),
    Schema.Struct({
      kind: Schema.Literal("transcript-line"),
      ...sessionFrame,
      line: Schema.Unknown,
    }),
    Schema.Struct({
      kind: Schema.Literal("hook"),
      ...sessionFrame,
      event_id: Schema.String,
      event_kind: Schema.String,
      payload: Schema.Unknown,
      requested_at: Schema.optional(Schema.Finite),
      expires_at: Schema.optional(Schema.Finite),
      hold: Schema.optional(Schema.ObjectKeyword),
    }),
    Schema.Struct({
      kind: Schema.Literal("hook-timed-out"),
      ...sessionFrame,
      event_kind: Schema.String,
      event_id: Schema.String,
    }),
    Schema.Struct({ kind: Schema.Literal("stopped"), ...tmuxFrame }),
    Schema.Struct({ kind: Schema.Literal("warning"), ...tmuxFrame, message: Schema.String }),
  ]),
});

const observationFields = {
  tab_id: Schema.String,
  environment_id: Schema.String,
  session_id: Schema.String,
  revision: Schema.Finite,
  observed_at: Schema.String,
};

/** The session's usage reading changed. */
export const tmuxAgentUsageEvent = defineEvent({
  domain: claudeTmuxDomain,
  name: "tmux-agent-usage",
  payload: Schema.Struct({ ...observationFields, usage: Schema.optional(Schema.Unknown) }),
});

/** A blocking prompt appeared in the session's pane. */
export const tmuxPromptDetectedEvent = defineEvent({
  domain: claudeTmuxDomain,
  name: "tmux-prompt-detected",
  payload: Schema.Struct({ ...observationFields, prompt: Schema.ObjectKeyword }),
});

/** The prompt went away. */
export const tmuxPromptClearedEvent = defineEvent({
  domain: claudeTmuxDomain,
  name: "tmux-prompt-cleared",
  payload: Schema.Struct({
    ...observationFields,
    previous_prompt: Schema.optional(Schema.Unknown),
  }),
});

/** `claude-state-<containerId>`: a container's Claude terminal changed state. */
export const claudeStateEvents = defineEventFamily({
  domain: claudeTmuxDomain,
  prefix: "claude-state-",
  payload: Schema.Struct({
    container_id: Schema.String,
    state: Schema.String,
    occurred_at: Schema.String,
  }),
});

export const CLAUDE_TMUX_EVENTS = [
  claudeTmuxEvent,
  tmuxAgentUsageEvent,
  tmuxPromptDetectedEvent,
  tmuxPromptClearedEvent,
  claudeStateEvents,
] as const;
