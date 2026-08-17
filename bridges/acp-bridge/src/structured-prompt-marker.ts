/**
 * Opening words of the structured-output instruction the bridge appends to a
 * schema-constrained prompt.
 *
 * Shared with the fake agent, whose echo branches reproduce the prompt back as
 * turn output and must cut the appended instruction off first — otherwise the
 * schema at the end of that instruction becomes the last well-formed JSON
 * document in the turn and is recovered as the structured result.
 *
 * A dependency-free module on purpose: the fake agent runs as its own process
 * and cannot import `acp-prompt.js`, which pulls in the provider-resolving
 * context module. Keeping the marker here is what stops the two from drifting
 * apart the next time the instruction is reworded.
 */
export const STRUCTURED_PROMPT_INSTRUCTION_PREFIX =
  "End your turn with exactly one JSON value";
