/**
 * The shape of `ask_agents`, shared by the agent tools server (every native
 * tab) and the coordinator's control MCP, so the tool has the same name,
 * description and input wherever an agent meets it.
 */
import { SUBORK_LIMITS } from "@orkestrator/protocol/suborks";
import { Schema } from "effect";
import { describe, list, str, strictObject } from "./tool-schema.js";

/**
 * Deliberately says when to use the tool and when not, because the plain-text
 * form ("ask opus 5.5 and grok 4.7 to rate this") relies on it: the backend does
 * not parse natural language.
 */
export const SUBORK_TOOL_DESCRIPTION = `Ask one or more other agents and get their answers back. Use this whenever the person asks you to ask, consult or get a second opinion from other agents or models by name, for example "ask codex to review this index.html" or "ask opus 5.5 and grok 4.7 to rate this code change out of 10". Use it instead of your own sub-agent or task tools for those requests.

Each target runs in parallel as a fresh read-only session in this workspace, in this working directory. It can read files and run commands that change nothing, and it cannot edit. It sees only the prompt you write and nothing of this conversation, so name every file, diff and fact it needs. It answers once.

The call returns immediately with a handle and does not wait. End your turn after calling it. All the answers arrive together, each labelled with its agent and model, in a new message that wakes you, and you continue from there. A target that is unknown, ambiguous or disabled fails on its own with a message listing close options, and the others still run. At most ${SUBORK_LIMITS.targetsPerCall} targets per call.`;

export const SUBORK_TOOL_INPUT_SCHEMA = strictObject({
  targets: list(
    strictObject({
      agent: Schema.optionalKey(
        describe(
          str({ trim: true, min: 1, max: SUBORK_LIMITS.targetTextMaxChars }),
          "An agent name, such as codex. Alone, it means that agent's saved default.",
        ),
      ),
      model: Schema.optionalKey(
        describe(
          str({ trim: true, min: 1, max: SUBORK_LIMITS.targetTextMaxChars }),
          "A model as the person said it, such as opus 5.5 or grok 4.7.",
        ),
      ),
      name: Schema.optionalKey(
        describe(
          str({ trim: true, min: 1, max: SUBORK_LIMITS.nameMaxChars }),
          "A short title for the transcript, such as Opus review.",
        ),
      ),
      prompt: Schema.optionalKey(
        describe(str({ min: 1 }), "A prompt for this target only, instead of the shared one."),
      ),
    }),
    { min: 1, max: 32 },
  ),
  prompt: Schema.optionalKey(
    describe(
      str({ min: 1 }),
      "The self-contained prompt every target receives, unless it has its own.",
    ),
  ),
  requestId: Schema.optionalKey(
    describe(
      str({ trim: true, min: 1, max: 256 }),
      "Repeat this to retry the same call without starting it twice.",
    ),
  ),
  tabId: Schema.optionalKey(
    describe(
      str({ trim: true, min: 1, max: 256 }),
      "Your own tab, when this environment has several and your credential is shared.",
    ),
  ),
});

export const SUBORK_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
