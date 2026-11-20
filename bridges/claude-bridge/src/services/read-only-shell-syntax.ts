/**
 * The shell grammar a read-only turn's commands may use, and nothing more.
 *
 * The read-only policy (`read-only-policy.ts`) judges a command by its words,
 * so it is only sound when the words it judges are exactly the words the shell
 * will pass to the program. This module admits the small part of the shell
 * whose words can be known before it runs, and refuses everything else:
 *
 * - **Words** are separated by spaces and tabs. A word may mix unquoted
 *   characters, backslash escapes (`\x` is `x`), single-quoted text (taken
 *   literally) and double-quoted text (taken literally, except that `\`
 *   before `$`, a backtick, `"` or `\` escapes it).
 * - **Lists**: `;`, a newline, `&&` and `||` separate commands, and `|`
 *   separates the stages of a pipeline. Each command is judged on its own, so
 *   a list runs only commands that were each admitted.
 * - **Variables**: a command that is nothing but `NAME=value`, with a plain
 *   value (no spaces, quotes-only characters or globs), sets `NAME` for the
 *   commands after it, and `$NAME` or `${NAME}` then expands to that value,
 *   unquoted or in double quotes. The assignment must run whatever came before
 *   it (first in the list, or after `;` or a newline) and may not be followed
 *   by `||`. Any other `$` is refused.
 * - **Refused unquoted**: redirection (`<`, `>`), background or `|&` (`&`),
 *   command substitution (a backtick, `$(`), grouping (`(`, `)`, `{`, `}`),
 *   globs (`*`, `?`, `[`, `]`), `!`, a line continuation, a `#` that starts a
 *   comment, a word that starts with `=` (zsh replaces it with a program's
 *   path), and a `~` that would expand to a home directory.
 *
 * Whoever admits a parsed command runs `serializeShellList` of what it
 * checked, not the original text: assignments are dropped, variables are
 * already substituted and every word is quoted, so the words checked are the
 * words that run by construction rather than by trusting this parser to agree
 * with the shell on every input.
 */

/** A separator between the commands of a list. A newline is read as `;`. */
export type ShellListOperator = ";" | "&&" | "||";

/** One element of a list: a pipeline of one or more commands, each its words. */
export interface ShellListItem {
  /** The operator before this item; absent on the first. */
  operator?: ShellListOperator;
  /** The pipeline's commands in order, each as the words the shell passes on. */
  pipeline: string[][];
}

/** Unquoted characters whose meaning depends on the shell's state, not the text. */
const UNQUOTED_REFUSED = new Set([
  "<",
  ">",
  "`",
  "(",
  ")",
  "{",
  "}",
  "*",
  "?",
  "[",
  "]",
  "!",
  "\r",
]);

/** Characters a double-quoted `\` escapes; before any other it is literal. */
const DOUBLE_QUOTE_ESCAPABLE = new Set(["$", "`", '"', "\\"]);

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A value a variable may hold: one that expands to exactly itself unquoted,
 * with no word splitting or globbing in either bash or zsh. An expansion's
 * result is not tilde-expanded, so `HEAD~1` is plain here.
 */
const PLAIN_VALUE = /^[A-Za-z0-9_@%+,./:~-][A-Za-z0-9_@%+,./:=~-]*$/;

/**
 * Parse `command` into a list of pipelines, or null when it uses anything this
 * grammar does not admit (see the module comment). A trailing `;` or newline
 * is allowed; any other empty command (`a ;; b`, `| grep x`, `a &&`), and a
 * command that is only assignments, is refused.
 */
export function parseReadOnlyShell(command: string): ShellListItem[] | null {
  const items: ShellListItem[] = [];
  const variables = new Map<string, string>();
  // The operator the next item is joined by.
  let operator: ShellListOperator | undefined;
  let pipeline: string[][] = [];
  let words: string[] = [];
  // The word being read, whether anything has made it a word yet (`''` is an
  // empty one), and the name it assigns when it starts `NAME=` unquoted.
  let word = "";
  let inWord = false;
  let quoted = false;
  let assigns: string | undefined;
  let firstAssigns: string | undefined;
  let trailingSeparator = false;
  // After `&&`, `||` or `|`, a newline continues the command rather than ending it.
  let awaitingCommand = false;

  const finishWord = () => {
    if (inWord) {
      if (words.length === 0 && pipeline.length === 0) firstAssigns = assigns;
      words.push(word);
    }
    word = "";
    inWord = false;
    quoted = false;
    assigns = undefined;
  };
  /** Close the current list item before `next`; false when it is empty or not admitted. */
  const finishItem = (next: ShellListOperator | undefined): boolean => {
    finishWord();
    if (words.length === 0) return false;
    pipeline.push(words);
    const name = firstAssigns;
    firstAssigns = undefined;
    if (pipeline.length === 1 && words.length === 1 && name !== undefined) {
      // `cmd && D=x` may not run the assignment, and `D=x || cmd` never runs `cmd`.
      if ((operator !== undefined && operator !== ";") || next === "||") return false;
      const value = words[0]!.slice(name.length + 1);
      if (!PLAIN_VALUE.test(value)) return false;
      variables.set(name, value);
      // Dropped: what follows joins the list as the assignment did.
      operator = items.length === 0 ? undefined : (operator ?? ";");
    } else {
      items.push({ ...(operator ? { operator } : {}), pipeline });
      operator = next;
    }
    pipeline = [];
    words = [];
    return true;
  };
  /** Expand `$NAME` or `${NAME}` at `index` (the `$`); the index after it, or -1. */
  const expand = (index: number): number => {
    let name: string;
    let end: number;
    if (command[index + 1] === "{") {
      const close = command.indexOf("}", index + 2);
      if (close < 0) return -1;
      name = command.slice(index + 2, close);
      end = close + 1;
    } else {
      name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(command.slice(index + 1))?.[0] ?? "";
      end = index + 1 + name.length;
    }
    const value = VARIABLE_NAME.test(name) ? variables.get(name) : undefined;
    if (value === undefined) return -1;
    word += value;
    inWord = true;
    quoted = true;
    return end;
  };

  for (let index = 0; index < command.length;) {
    const char = command[index]!;
    if (char !== "\n" && char !== ";" && char !== " " && char !== "\t") {
      trailingSeparator = false;
      awaitingCommand = false;
    }
    if (char === " " || char === "\t" || (char === "\n" && awaitingCommand)) {
      finishWord();
      index += 1;
    } else if (char === "\n" || char === ";") {
      if (trailingSeparator || !finishItem(";")) {
        // Only a run of blank lines after a complete item is harmless.
        if (!(char === "\n" && trailingSeparator)) return null;
      }
      trailingSeparator = true;
      index += 1;
    } else if (char === "&") {
      if (command[index + 1] !== "&" || !finishItem("&&")) return null;
      index += 2;
      awaitingCommand = true;
    } else if (char === "|") {
      if (command[index + 1] === "&") return null;
      if (command[index + 1] === "|") {
        if (!finishItem("||")) return null;
        index += 2;
        awaitingCommand = true;
        continue;
      }
      finishWord();
      if (words.length === 0) return null;
      pipeline.push(words);
      words = [];
      index += 1;
      awaitingCommand = true;
    } else if (char === "'") {
      const end = command.indexOf("'", index + 1);
      if (end < 0) return null;
      word += command.slice(index + 1, end);
      inWord = true;
      quoted = true;
      index = end + 1;
    } else if (char === '"') {
      inWord = true;
      quoted = true;
      index += 1;
      for (;;) {
        const inner = command[index];
        if (inner === undefined || inner === "`") return null;
        if (inner === '"') {
          index += 1;
          break;
        }
        if (inner === "$") {
          index = expand(index);
          if (index < 0) return null;
          continue;
        }
        if (inner === "\\") {
          const next = command[index + 1];
          if (next === undefined || next === "\n") return null;
          if (DOUBLE_QUOTE_ESCAPABLE.has(next)) {
            word += next;
            index += 2;
            continue;
          }
        }
        word += inner;
        index += 1;
      }
    } else if (char === "\\") {
      const next = command[index + 1];
      // A line continuation joins lines in ways a word-by-word reading misses.
      if (next === undefined || next === "\n" || next === "\r") return null;
      word += next;
      inWord = true;
      quoted = true;
      index += 2;
    } else if (char === "$") {
      index = expand(index);
      if (index < 0) return null;
    } else {
      if (UNQUOTED_REFUSED.has(char)) return null;
      // A comment, and zsh's `=program` path expansion, at the start of a word.
      if (!inWord && (char === "#" || char === "=")) return null;
      // Tilde expansion: at the start of a word, and after an `=` or `:`.
      if (char === "~" && (!inWord || word.endsWith("=") || word.endsWith(":"))) return null;
      if (char === "=" && !quoted && assigns === undefined && VARIABLE_NAME.test(word)) {
        assigns = word;
      }
      word += char;
      inWord = true;
      index += 1;
    }
  }
  if (!trailingSeparator && !finishItem(undefined)) return null;
  if (pipeline.length > 0 || words.length > 0) return null;
  // A list operator with nothing after it (`a &&`, `a ||`).
  if (operator === "&&" || operator === "||") return null;
  return items.length > 0 ? items : null;
}

/**
 * Words that mean nothing to a shell: no quoting, no expansion. `~` is literal
 * inside a word except after `=` or `:`, and a leading `=` is zsh's path
 * expansion. `^` is left out for zsh's extended globbing.
 */
const PLAIN_WORD = /^[A-Za-z0-9_@%+,./:-][A-Za-z0-9_@%+,./:=~-]*$/;

/** `word` as shell text that passes exactly `word`: as it is when plain, single-quoted otherwise. */
export function quoteShellWord(word: string): string {
  if (PLAIN_WORD.test(word) && !/[=:]~/.test(word)) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The shell text for a parsed list, every word quoted as `quoteShellWord` does. */
export function serializeShellList(items: readonly ShellListItem[]): string {
  return items
    .map((item, index) => {
      const pipeline = item.pipeline
        .map((words) => words.map(quoteShellWord).join(" "))
        .join(" | ");
      if (index === 0) return pipeline;
      return item.operator === ";" ? `; ${pipeline}` : ` ${item.operator ?? ";"} ${pipeline}`;
    })
    .join("");
}
