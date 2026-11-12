/**
 * Terminal output as the text a person sees: every escape sequence and
 * non-printing control a shell interleaves removed, so a spec can compare
 * whole lines of a `get_terminal_output_snapshot` (to-do 7340, retired 2026-11-11; failure 4741).
 *
 * The one copy for the agent-testing specs. Keep whole-line assertions after
 * stripping: matching text anywhere can pass on the echoed command. Do not
 * hide a sequence by changing the host's shell startup files instead.
 *
 * Removed, in this order (an OSC or DCS introducer is itself a two-character
 * escape, so the longer forms go first):
 *
 * 1. OSC strings ending in BEL or ST, such as a beelink prompt's OSC 3008
 *    context marks and window titles;
 * 2. DCS strings ending in ST;
 * 3. CSI sequences (colours, cursor moves, private modes);
 * 4. escapes with intermediate bytes, such as the character-set selection
 *    `ESC ( B` that `tput sgr0` emits;
 * 5. other two-character escapes: every final byte from `0` to `~`, so the
 *    keypad modes `ESC =` and `ESC >`, cursor save and restore `ESC 7` and
 *    `ESC 8`, and `ESC M`;
 * 6. C0 controls and DEL, except `\n` and `\t`. A carriage return goes, so a
 *    CRLF line compares like an LF line; a tab is kept as the whitespace it
 *    renders as.
 */
export const TERMINAL_ESCAPE_PATTERNS: readonly RegExp[] = [
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,
  /\x1bP[^\x1b]*\x1b\\/g,
  /\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g,
  /\x1b[ -/]+[0-~]/g,
  /\x1b[0-~]/g,
  /[\x00-\x08\x0b-\x1f\x7f]/g,
];

export function terminalVisibleText(output: string): string {
  let text = output;
  for (const pattern of TERMINAL_ESCAPE_PATTERNS) text = text.replace(pattern, "");
  return text;
}

/**
 * The same function as page source, for code a spec evaluates inside the
 * renderer (`local-gateway-transport-cpu-page.ts`). Built from each pattern's
 * `RegExp.prototype.toString`, which the language defines as a valid literal,
 * so it never depends on how a bundler prints a function.
 */
export const TERMINAL_VISIBLE_TEXT_PAGE_SOURCE = `((text) => text${TERMINAL_ESCAPE_PATTERNS.map(
  (pattern) => `.replace(${pattern.toString()}, "")`,
).join("")})`;
