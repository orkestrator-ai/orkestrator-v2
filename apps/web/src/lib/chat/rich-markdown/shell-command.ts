/**
 * Eligibility for the explicit "Run in terminal" action on a shell fence.
 *
 * Only a complete, single-line command in a shell-language fence qualifies,
 * and only while the text has stopped streaming and was not clipped. Hidden
 * control/bidirectional characters and incomplete continuations are refused,
 * so what the user reads is exactly what would run. Rendering never runs
 * anything; the caller routes an explicit click through the existing terminal
 * capability.
 */
import { SHELL_FENCE_LANGUAGES } from "@/lib/chat/highlighter/languages";

export type ShellCommandEligibility =
  | { ok: true; command: string }
  | {
      ok: false;
      reason:
        | "not-shell"
        | "incomplete"
        | "streaming"
        | "clipped"
        | "multi-line"
        | "empty"
        | "hidden-characters"
        | "continuation";
    };

/**
 * C0/C1 controls (tab included), bidi formatting, zero-width, line/paragraph
 * separators and BOM. Built from a string: a literal U+2028 escape inside a
 * regex literal is rewritten to a raw line terminator by some transpilers.
 */
const HIDDEN_CHARACTERS = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u202a-\\u202e\\u2028\\u2029\\u2066-\\u2069\\ufeff]",
);

/** Trailing backslash, pipe, `&&`/`||`, or an opened heredoc: the command continues elsewhere. */
const CONTINUATION = /(\\|\||&&|<<-?\s*['"]?\w*['"]?)\s*$/;

export const SHELL_INELIGIBLE_REASON: Record<
  Exclude<ShellCommandEligibility, { ok: true }>["reason"],
  string
> = {
  "not-shell": "Only shell code blocks can run in a terminal",
  incomplete: "The code block is not complete yet",
  streaming: "Wait for the response to finish before running this command",
  clipped: "This code block was clipped and may be incomplete",
  "multi-line": "Only a single-line command can run from the transcript",
  empty: "There is no command to run",
  "hidden-characters": "The command contains hidden control or direction characters",
  continuation: "The command continues on another line",
};

export function shellCommandEligibility(input: {
  source: string;
  language: string | null;
  closed: boolean;
  live: boolean;
  clipped: boolean;
}): ShellCommandEligibility {
  if (!input.language || !SHELL_FENCE_LANGUAGES.has(input.language))
    return { ok: false, reason: "not-shell" };
  if (!input.closed) return { ok: false, reason: "incomplete" };
  if (input.clipped) return { ok: false, reason: "clipped" };
  if (input.live) return { ok: false, reason: "streaming" };
  // One trailing line terminator is the fence's own line structure.
  const body = input.source.replace(/\r?\n$/, "");
  if (/[\r\n]/.test(body)) return { ok: false, reason: "multi-line" };
  let command = body.trim();
  if (input.language === "console" && command.startsWith("$ ")) command = command.slice(2).trim();
  if (!command) return { ok: false, reason: "empty" };
  if (HIDDEN_CHARACTERS.test(body)) return { ok: false, reason: "hidden-characters" };
  if (CONTINUATION.test(command)) return { ok: false, reason: "continuation" };
  return { ok: true, command };
}
