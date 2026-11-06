/**
 * Claude Code PreToolUse hook for the Bash tool (`.claude/settings.json`).
 *
 * Production Orkestrator shares this host with the agents that build it, and
 * its backend, bridges and agent CLIs look like the processes tests start.
 * AGENTS.md forbids signalling processes by name, pattern or port, and an agent
 * under pressure still did. This hook refuses the command instead:
 *
 * - `pkill` and `killall`, which select processes by name;
 * - `fuser -k`, which selects them by file or port;
 * - `kill` whose targets come from a command (`$(pgrep x)`, backticks, or
 *   `… | xargs kill`), which is the same thing spelled differently;
 * - `kill 0` and `kill -1`, which signal the caller's whole process group or
 *   every process the user owns.
 *
 * `kill <pid>` and `kill $VAR` stay allowed: signalling a pid you recorded at
 * spawn time is exactly what the rules ask for. Text inside quotes is ignored
 * unless it is run as a command (`sh -c '…'`, `eval '…'`), and heredoc bodies
 * are ignored, so a commit message that mentions `pkill` is not refused.
 *
 * Exit 2 with a reason on stderr blocks the tool call; exit 0 allows it. Any
 * failure to read or parse the hook input allows the call: this is a guard
 * against a known mistake, not a sandbox.
 */

const WRAPPERS = new Set([
  "sudo",
  "doas",
  "exec",
  "command",
  "builtin",
  "nohup",
  "nice",
  "env",
  "time",
  "setsid",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

const REASON =
  "Blocked: this command signals processes chosen by name, pattern, port, command output or process group. " +
  'Production Orkestrator shares this host, and AGENTS.md ("Production Orkestrator shares this host") forbids it. ' +
  "Signal only processes you spawned, through the handle or pid you recorded at spawn time.";

type Segment = { words: string[] };

/** Removes heredoc bodies: their text is data, not commands. */
function stripHeredocs(source: string): string {
  const lines = source.split("\n");
  const kept: string[] = [];
  const pending: { delimiter: string; tabs: boolean }[] = [];
  for (const line of lines) {
    const current = pending[0];
    if (current) {
      const candidate = current.tabs ? line.replace(/^\t+/, "") : line;
      if (candidate === current.delimiter) pending.shift();
      continue;
    }
    kept.push(line);
    for (const match of line.matchAll(/<<(-?)\s*(['"]?)([A-Za-z_][\w.-]*)\2/g)) {
      pending.push({ delimiter: match[3]!, tabs: match[1] === "-" });
    }
  }
  return kept.join("\n");
}

/**
 * Splits a command line into simple commands at top-level separators. Quoted
 * text, `$(…)` and backticks stay inside the word they belong to; their
 * commands are returned separately in `nested` so they are checked too.
 */
function tokenize(source: string, nested: string[]): Segment[] {
  const segments: Segment[] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push({ words });
    words = [];
  };

  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\\" && index + 1 < source.length) {
      word += source[index + 1];
      inWord = true;
      index += 2;
    } else if (char === "'") {
      const end = source.indexOf("'", index + 1);
      const stop = end === -1 ? source.length : end;
      word += `'${source.slice(index + 1, stop)}'`;
      inWord = true;
      index = stop + 1;
    } else if (char === '"') {
      let cursor = index + 1;
      let text = "";
      while (cursor < source.length && source[cursor] !== '"') {
        if (source[cursor] === "\\" && cursor + 1 < source.length) {
          text += source[cursor + 1];
          cursor += 2;
        } else if (source.startsWith("$(", cursor)) {
          const end = matchingParen(source, cursor + 1);
          nested.push(source.slice(cursor + 2, end));
          text += source.slice(cursor, end + 1);
          cursor = end + 1;
        } else if (source[cursor] === "`") {
          const end = source.indexOf("`", cursor + 1);
          const stop = end === -1 ? source.length : end;
          nested.push(source.slice(cursor + 1, stop));
          text += source.slice(cursor, stop + 1);
          cursor = stop + 1;
        } else {
          text += source[cursor];
          cursor += 1;
        }
      }
      word += `"${text}"`;
      inWord = true;
      index = cursor + 1;
    } else if (source.startsWith("$(", index)) {
      const end = matchingParen(source, index + 1);
      nested.push(source.slice(index + 2, end));
      word += source.slice(index, end + 1);
      inWord = true;
      index = end + 1;
    } else if (char === "`") {
      const end = source.indexOf("`", index + 1);
      const stop = end === -1 ? source.length : end;
      nested.push(source.slice(index + 1, stop));
      word += source.slice(index, stop + 1);
      inWord = true;
      index = stop + 1;
    } else if (char === "#" && !inWord) {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
    } else if (";&|\n(){}".includes(char)) {
      endSegment();
      index += 1;
    } else if (char === " " || char === "\t") {
      endWord();
      index += 1;
    } else {
      word += char;
      inWord = true;
      index += 1;
    }
  }
  endSegment();
  return segments;
}

/** Index of the `)` closing the `(` at `open`, or the end of the source. */
function matchingParen(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return source.length;
}

function unquote(word: string): string {
  return /^(['"]).*\1$/s.test(word) ? word.slice(1, -1) : word;
}

/**
 * True when a `kill` target reaches beyond processes the caller can name: a
 * target computed by a command, `0` (the caller's process group) or `-1`
 * (every process the user may signal). One leading signal option (`-9`,
 * `-TERM`, `-s TERM`, `-n 9`) and a `--` precede the targets, so in
 * `kill -1 1234` the `-1` is SIGHUP but in `kill -9 -1` it is a target.
 */
function isBroadKillTarget(words: readonly string[]): boolean {
  if (words.some((word) => word.includes("$(") || word.includes("`"))) return true;
  const plain = words.map(unquote);
  let first = 0;
  if (plain[0] !== undefined && plain[0] !== "--" && plain[0].startsWith("-")) {
    first = plain[0] === "-s" || plain[0] === "-n" ? 2 : 1;
  }
  if (plain[first] === "--") first += 1;
  return plain.slice(first).some((target) => target === "0" || target === "-1");
}

function checkSegment(segment: Segment, depth: number): string | null {
  const words = segment.words;
  let index = 0;
  let viaXargs = false;
  while (index < words.length) {
    const word = unquote(words[index]!);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      index += 1;
    } else if (WRAPPERS.has(word)) {
      index += 1;
      while (index < words.length && unquote(words[index]!).startsWith("-")) index += 1;
    } else if (word === "timeout") {
      index += 1;
      while (index < words.length && unquote(words[index]!).startsWith("-")) index += 1;
      index += 1; // the duration
    } else if (word === "xargs") {
      viaXargs = true;
      index += 1;
      while (index < words.length && unquote(words[index]!).startsWith("-")) index += 1;
    } else {
      break;
    }
  }
  const program =
    unquote(words[index] ?? "")
      .split("/")
      .pop() ?? "";
  const args = words.slice(index + 1);

  if (program === "pkill" || program === "killall") return program;
  if (program === "fuser" && args.some((arg) => /^-[A-Za-z]*k/.test(unquote(arg))))
    return "fuser -k";
  if (program === "kill" && (viaXargs || isBroadKillTarget(args))) return "kill";
  if (SHELLS.has(program) || program === "eval") {
    const scriptIndex =
      program === "eval" ? 0 : args.findIndex((arg) => /^-[A-Za-z]*c$/.test(unquote(arg))) + 1;
    if (scriptIndex > 0 || program === "eval") {
      const script =
        program === "eval" ? args.map(unquote).join(" ") : unquote(args[scriptIndex] ?? "");
      return findBroadKill(script, depth + 1);
    }
  }
  return null;
}

/** Names the refused command in `source`, or null when it may run. */
export function findBroadKill(source: string, depth = 0): string | null {
  if (depth > 8) return null;
  const nested: string[] = [];
  for (const segment of tokenize(stripHeredocs(source), nested)) {
    const found = checkSegment(segment, depth);
    if (found) return found;
  }
  for (const inner of nested) {
    const found = findBroadKill(inner, depth + 1);
    if (found) return found;
  }
  return null;
}

if (import.meta.main) {
  let command: unknown;
  try {
    const input = JSON.parse(await Bun.stdin.text()) as { tool_input?: { command?: unknown } };
    command = input.tool_input?.command;
  } catch {
    process.exit(0);
  }
  if (typeof command === "string") {
    const found = findBroadKill(command);
    if (found) {
      process.stderr.write(`${REASON} (matched: ${found})\n`);
      process.exit(2);
    }
  }
  process.exit(0);
}
