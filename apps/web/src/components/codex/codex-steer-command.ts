export interface ParsedCodexSteerCommand {
  matched: boolean;
  input: string;
}

/**
 * Recognises the native compose-only `/steer` command without mistaking prompt
 * commands such as `/steering` for it. The body may span multiple lines; Codex
 * app-server accepts it as one text input on the active turn.
 */
export function parseCodexSteerCommand(value: string): ParsedCodexSteerCommand {
  const match = /^\/steer(?:\s+([\s\S]*))?$/i.exec(value.trim());
  return match
    ? { matched: true, input: (match[1] ?? "").trim() }
    : { matched: false, input: "" };
}
