/**
 * Slash commands and prompt shaping.
 *
 * Kept out of the engine deliberately: expanding a prompt template, resolving a
 * built-in and applying the plan-mode wrapper are all decisions about *what the
 * model is asked*, independent of how the turn is executed.
 *
 * Template discovery lives in `template-discovery.ts` and the file format in
 * `template-format.ts`; the executable catalogue that ties templates, skills
 * and built-ins together is `commands/codex-command-catalogue.ts`. Inline
 * shell expansion (`!` + backtick spans) was removed: templates that use it are
 * listed as unavailable and refused before anything runs.
 */
import type { Input, UserInput } from "../codex-item-types.js";
import type { PromptAttachmentInput } from "../sessions/thread-registry.js";

export { extractFrontmatter, summarizePromptTemplate } from "./template-format.js";

export type ConversationMode = "build" | "plan";

/**
 * `/steer` accepts free-form text, including newlines, unlike prompt-template
 * slash commands. Parse it separately so an idle/stale client cannot leak a
 * multiline steering command into a newly started model turn.
 */
export function parseCodexSteerCommand(prompt: string): { args: string } | null {
  const match = /^\/steer(?:\s+([\s\S]*))?$/i.exec(prompt.trim());
  return match ? { args: (match[1] ?? "").trim() } : null;
}

export function resolveConversationMode(body: Record<string, unknown>): ConversationMode {
  return body.mode === "plan" || body.mode === "build" ? (body.mode as ConversationMode) : "build";
}

// NOTE: This is a soft hint prepended to the user message, not a true system
// prompt.  The model may not enforce it perfectly and a determined user could
// override it.  This is acceptable because plan mode is a UX convenience, not
// a security boundary.
export function wrapPromptForConversationMode(prompt: string, mode: ConversationMode): string {
  if (mode !== "plan") {
    return prompt;
  }

  const preamble = [
    "<system-reminder>",
    "You are in Orkestrator plan mode.",
    "This turn is planning-only. The user expects analysis, a concrete plan, and optional diffs before any implementation.",
    "Treat the current session as consultative and read-only.",
    "Do not claim to have made changes, completed implementation, or written files.",
    "Do not attempt mutating commands or filesystem writes.",
    "Inspect the codebase as needed, then produce:",
    "1. a concise implementation plan,",
    "2. important risks or open questions,",
    "3. exact diffs or patch snippets when useful.",
    "If the user approves the plan later, they will switch you back to build mode in a later turn.",
    "</system-reminder>",
  ].join("\n");

  return `${preamble}\n\n${prompt}`;
}

export function buildPromptInput(prompt: string, attachments: PromptAttachmentInput[]): Input {
  if (attachments.length === 0) {
    return prompt;
  }

  const input: UserInput[] = [];
  if (prompt.length > 0) {
    input.push({ type: "text", text: prompt });
  }

  for (const attachment of attachments) {
    input.push({
      type: "local_image",
      path: attachment.path,
    });
  }

  return input;
}
