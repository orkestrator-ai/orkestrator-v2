/**
 * Which shell commands a read-only Codex turn without Codex's command sandbox
 * may run (`codex-read-only-sandbox.ts`).
 *
 * Such a turn runs under Codex's `untrusted` approval policy. The pinned Codex
 * (0.167.0) asks for approval for every command that no exec-policy rule
 * allows, reads included, so a gate that declined every approval left a
 * container reviewer unable to run `cat`. The bridge therefore answers each
 * command approval itself: a command this module proves only reads is
 * approved, and everything else is declined. Nothing here depends on how
 * Codex classifies a command, so a Codex that asks for fewer commands only
 * means fewer approvals reach this check.
 *
 * An allowlist, as in the Claude bridge's coordinator boundary
 * (`bridges/claude-bridge/src/services/read-only-policy.ts`), whose tables
 * this follows. The differences are deliberate:
 *
 * - Codex sends a shell command (`/bin/bash -lc '<script>'`), so this lexes
 *   POSIX quoting rather than refusing every quote. Single quotes are literal;
 *   double quotes are accepted only without `$`, a backtick or a backslash.
 *   Pipes and `&&`, `||`, `;` and newlines join commands, and every command
 *   in the chain is checked. Redirection, substitution, variables, globs,
 *   escapes, subshells, background jobs and assignments refuse the whole
 *   command: the command that runs must be the one checked.
 * - `awk` is absent: with quoting allowed its program can call `system()` or
 *   print to a file. `sed` is admitted only for line-range printing.
 * - Git's inspection subcommands are admitted without an OS sandbox. They can
 *   still launch helpers named in the checkout's local `.git/config`
 *   (`diff.external`, `core.fsmonitor`); this gate runs only inside an
 *   environment's container, which is the boundary there.
 */

export type ReadOnlyCommandVerdict = { allowed: true } | { allowed: false; reason: string };

/** Programs whose whole purpose is to read. `cd` only moves the shell. */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "basename",
  "cat",
  "cd",
  "cksum",
  "column",
  "comm",
  "cut",
  "date",
  "diff",
  "dirname",
  "du",
  "echo",
  "file",
  "find",
  "fd",
  "grep",
  "head",
  "hostname",
  "jq",
  "ls",
  "md5sum",
  "nl",
  "od",
  "printf",
  "pwd",
  "readlink",
  "realpath",
  "rg",
  "sha1sum",
  "sha256sum",
  "sort",
  "stat",
  "tail",
  "tr",
  "true",
  "uniq",
  "wc",
  "which",
  "whoami",
  "xxd",
  "yq",
]);

/** Arguments that turn a reading program into a writing (or launching) one. */
const MUTATING_ARGUMENTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["date", new Set(["-s", "--set"])],
  ["fd", new Set(["-x", "-X", "--exec", "--exec-batch"])],
  ["file", new Set(["-C", "--compile"])],
  [
    "find",
    new Set([
      "-delete",
      "-exec",
      "-execdir",
      "-fls",
      "-fprint",
      "-fprint0",
      "-fprintf",
      "-ok",
      "-okdir",
    ]),
  ],
  ["hostname", new Set(["-F", "--file", "-b", "--boot"])],
  ["rg", new Set(["--hostname-bin", "--pre"])],
  ["sort", new Set(["-o", "--output", "-T", "--temporary-directory", "--compress-program"])],
  ["yq", new Set(["-i", "--in-place", "--inplace", "-s", "--split-exp"])],
]);

/** Programs that write a positional argument (`uniq in out`). */
const POSITIONAL_LIMITS: ReadonlyMap<
  string,
  { max: number; valueOptions: ReadonlySet<string>; stopAtFirstOperand?: boolean }
> = new Map([
  ["cd", { max: 1, valueOptions: new Set<string>() }],
  ["hostname", { max: 0, valueOptions: new Set<string>() }],
  ["uniq", { max: 1, valueOptions: new Set(["-f", "-s", "-w"]) }],
  [
    "xxd",
    {
      max: 1,
      stopAtFirstOperand: true,
      valueOptions: new Set([
        "-c",
        "-cols",
        "-g",
        "-groupsize",
        "-l",
        "-len",
        "-n",
        "-name",
        "-o",
        "-offset",
        "-s",
        "-seek",
      ]),
    },
  ],
]);

/** Git options allowed before the subcommand; anything else points Git elsewhere. */
const GIT_GLOBAL_OPTIONS: ReadonlySet<string> = new Set([
  "-P",
  "--literal-pathspecs",
  "--no-optional-locks",
  "--no-pager",
]);

/** Git options that write a file or choose a program to run. */
const GIT_MUTATING_ARGUMENTS: ReadonlySet<string> = new Set([
  "--config-env",
  "--exec-path",
  "--ext-diff",
  "--filters",
  "--output",
  "--textconv",
]);

const GIT_SUBCOMMAND_MUTATING_ARGUMENTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["grep", new Set(["-O", "--open-files-in-pager"])],
]);

/** Git subcommands that only inspect, whatever their arguments. */
const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "blame",
  "cat-file",
  "describe",
  "diff",
  "grep",
  "log",
  "ls-files",
  "ls-tree",
  "merge-base",
  "name-rev",
  "rev-list",
  "rev-parse",
  "shortlog",
  "show",
  "show-ref",
  "status",
  "whatchanged",
]);

const GIT_REF_WRITE_FLAGS: ReadonlySet<string> = new Set([
  "-C",
  "-D",
  "-M",
  "-c",
  "-d",
  "-f",
  "-m",
  "-u",
  "--copy",
  "--delete",
  "--edit-description",
  "--force",
  "--move",
  "--set-upstream-to",
  "--unset-upstream",
]);

const GIT_REF_LIST_FLAGS: ReadonlySet<string> = new Set([
  "-l",
  "--list",
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
  "--show-current",
]);

/** `git branch` and `git tag` list with no positional and create with one. */
function listsRefsOnly(args: readonly string[]): boolean {
  if (hasFlag(args, GIT_REF_WRITE_FLAGS)) return false;
  const positionals = args.filter((arg) => !arg.startsWith("-"));
  return positionals.length === 0 || hasFlag(args, GIT_REF_LIST_FLAGS);
}

/** A `Map`, not an object literal: the key comes from the model (`constructor`). */
const CONDITIONAL_GIT_SUBCOMMANDS: ReadonlyMap<string, (args: readonly string[]) => boolean> =
  new Map([
    ["branch", listsRefsOnly],
    ["tag", listsRefsOnly],
  ]);

const SED_OPTIONS: ReadonlySet<string> = new Set([
  "-n",
  "-E",
  "-r",
  "--quiet",
  "--silent",
  "--regexp-extended",
]);

/** `1,80p`, `$p`, `10,+5p` or `80q`: printing lines, nothing that writes or runs. */
const SED_PRINT_PART = /^\s*(?:\d+|\$)(?:\s*,\s*(?:\d+|\$|\+\d+))?\s*p\s*$/;
const SED_QUIT_PART = /^\s*\d+\s*q\s*$/;

/** A shell that only wraps the script Codex checks: `/bin/bash -lc '<script>'`. */
const WRAPPING_SHELL = /^(?:\/usr(?:\/local)?\/bin\/|\/bin\/)?(?:ba|z|da)?sh$/;
const WRAPPING_FLAGS: ReadonlySet<string> = new Set(["-c", "-lc"]);

/** Said with every refusal, so the model knows what it can still do. */
const ALLOWED_SUMMARY =
  "Only reading programs run here (cat, rg, grep, ls, find, head, tail, wc, `sed -n 'N,Mp'`, and git status, diff, log, show and similar), joined with |, && or ; and without redirection, substitution, variables or globs.";

function refuse(detail: string): ReadOnlyCommandVerdict {
  return {
    allowed: false,
    reason: `This read-only turn runs without Codex's command sandbox, so Orkestrator declined it: ${detail} ${ALLOWED_SUMMARY}`,
  };
}

type Token = { op: false; value: string } | { op: true; value: "|" | "&&" | "||" | ";" };

/**
 * Splits a shell script into words and control operators, or explains why it
 * cannot be checked. Only constructs whose effect is fully known are lexed;
 * everything else refuses.
 */
function lex(script: string): Token[] | string {
  const tokens: Token[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) tokens.push({ op: false, value: word });
    word = "";
    inWord = false;
  };
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index]!;
    if (char === " " || char === "\t") {
      endWord();
      continue;
    }
    if (char === "\n" || char === "\r" || char === ";") {
      endWord();
      tokens.push({ op: true, value: ";" });
      continue;
    }
    if (char === "|") {
      endWord();
      if (script[index + 1] === "|") {
        tokens.push({ op: true, value: "||" });
        index += 1;
      } else if (script[index + 1] === "&") {
        return "it pipes standard error with `|&`.";
      } else {
        tokens.push({ op: true, value: "|" });
      }
      continue;
    }
    if (char === "&") {
      endWord();
      if (script[index + 1] !== "&") return "it runs a command in the background.";
      tokens.push({ op: true, value: "&&" });
      index += 1;
      continue;
    }
    if (char === "'") {
      const end = script.indexOf("'", index + 1);
      if (end < 0) return "it has an unterminated quote.";
      word += script.slice(index + 1, end);
      inWord = true;
      index = end;
      continue;
    }
    if (char === '"') {
      const end = script.indexOf('"', index + 1);
      if (end < 0) return "it has an unterminated quote.";
      const quoted = script.slice(index + 1, end);
      if (/[$`\\]/.test(quoted)) {
        return "it expands a variable, a substitution or an escape inside double quotes.";
      }
      word += quoted;
      inWord = true;
      index = end;
      continue;
    }
    if (char === "<" || char === ">") return "it redirects input or output.";
    if (char === "$" || char === "`") return "it expands a variable or a command substitution.";
    if (char === "\\") return "it uses a shell escape.";
    if ("(){}".includes(char)) return "it uses a subshell, a group or a brace expansion.";
    if ("*?[]".includes(char)) return "it uses a glob, which can expand to an option.";
    if (!inWord && (char === "#" || char === "~")) {
      return char === "#" ? "it contains a shell comment." : "it uses tilde expansion.";
    }
    word += char;
    inWord = true;
  }
  endWord();
  return tokens;
}

/** Splits lexed tokens into the simple commands they chain. */
function commands(tokens: readonly Token[]): string[][] | string {
  const result: string[][] = [];
  let current: string[] = [];
  let previous: Token["value"] | undefined;
  for (const token of tokens) {
    if (!token.op) {
      current.push(token.value);
      previous = undefined;
      continue;
    }
    if (current.length === 0) {
      // `;` and newlines may repeat or lead; a pipe or a list operator needs a
      // command on both sides.
      if (token.value !== ";" || (previous !== undefined && previous !== ";")) {
        return "it has an operator with no command beside it.";
      }
    } else {
      result.push(current);
      current = [];
    }
    previous = token.value;
  }
  if (current.length > 0) result.push(current);
  else if (previous !== undefined && previous !== ";") {
    return "it ends with an operator.";
  }
  return result;
}

/** The script a wrapping shell runs, or the words themselves when unwrapped. */
function unwrap(words: readonly string[]): string | undefined {
  if (words.length === 3 && WRAPPING_SHELL.test(words[0]!) && WRAPPING_FLAGS.has(words[1]!)) {
    return words[2]!;
  }
  return undefined;
}

/**
 * Whether `command` only reads. A string is the command as Codex shows it
 * (`/bin/bash -lc 'rg -n foo'`, or a bare script); an array is a legacy argv.
 */
export function codexReadOnlyCommandVerdict(
  command: string | readonly string[],
): ReadOnlyCommandVerdict {
  let simple: string[][];
  if (typeof command === "string") {
    const outer = lex(command);
    if (typeof outer === "string") return refuse(outer);
    const words = outer.every((token) => !token.op) ? outer.map((token) => token.value) : [];
    const script = unwrap(words);
    const inner = script === undefined ? outer : lex(script);
    if (typeof inner === "string") return refuse(inner);
    const split = commands(inner);
    if (typeof split === "string") return refuse(split);
    simple = split;
  } else {
    const script = unwrap(command);
    if (script === undefined) {
      // An argv is executed as written: no shell sees it.
      simple = command.length > 0 ? [[...command]] : [];
    } else {
      const inner = lex(script);
      if (typeof inner === "string") return refuse(inner);
      const split = commands(inner);
      if (typeof split === "string") return refuse(split);
      simple = split;
    }
  }
  if (simple.length === 0) return refuse("it names no command.");
  for (const argv of simple) {
    const verdict = simpleCommandVerdict(argv);
    if (!verdict.allowed) return verdict;
  }
  return { allowed: true };
}

function simpleCommandVerdict(argv: readonly string[]): ReadOnlyCommandVerdict {
  const program = argv[0] ?? "";
  const args = argv.slice(1);
  if (program.includes("=")) return refuse("it assigns an environment variable.");
  if (program.includes("/") || program.includes("\\")) {
    return refuse(`\`${program}\` names a path rather than a program.`);
  }
  if (program === "git") return gitVerdict(args);
  if (program === "sed") return sedVerdict(args);
  if (!READ_ONLY_COMMANDS.has(program)) return refuse(`\`${program}\` is not a reading program.`);
  const mutating = MUTATING_ARGUMENTS.get(program);
  const limit = POSITIONAL_LIMITS.get(program);
  if (
    (mutating && hasFlag(args, mutating)) ||
    (limit && positionalCount(args, limit.valueOptions, limit.stopAtFirstOperand) > limit.max)
  ) {
    return refuse(`\`${program}\` was given an argument that writes or runs another program.`);
  }
  return { allowed: true };
}

function gitVerdict(tokens: readonly string[]): ReadOnlyCommandVerdict {
  const subcommandIndex = tokens.findIndex((token) => !token.startsWith("-"));
  const globalOptions = subcommandIndex < 0 ? tokens : tokens.slice(0, subcommandIndex);
  const unlisted = globalOptions.find((option) => !GIT_GLOBAL_OPTIONS.has(option));
  if (unlisted) return refuse(`the Git option \`${unlisted}\` is not available here.`);
  const subcommand = subcommandIndex < 0 ? undefined : tokens[subcommandIndex]!;
  const args = subcommandIndex < 0 ? [] : tokens.slice(subcommandIndex + 1);
  const permitted =
    subcommand !== undefined &&
    (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand) ||
      (CONDITIONAL_GIT_SUBCOMMANDS.get(subcommand)?.(args) ?? false));
  const described = ["git", subcommand].filter(Boolean).join(" ");
  if (!permitted) return refuse(`\`${described}\` is not a reading Git command.`);
  if (
    hasFlag(tokens, GIT_MUTATING_ARGUMENTS) ||
    hasFlag(args, GIT_SUBCOMMAND_MUTATING_ARGUMENTS.get(subcommand) ?? new Set())
  ) {
    return refuse(`\`${described}\` was given an argument that writes or runs another program.`);
  }
  return { allowed: true };
}

/** `sed` prints line ranges only: no `w`, `e`, `-i` or anything else. */
function sedVerdict(args: readonly string[]): ReadOnlyCommandVerdict {
  const scripts: string[] = [];
  const operands: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "-e" || arg === "--expression") {
      const value = args[index + 1];
      if (value === undefined) return refuse("`sed -e` is missing its script.");
      scripts.push(value);
      index += 1;
    } else if (arg.startsWith("--expression=")) {
      scripts.push(arg.slice("--expression=".length));
    } else if (arg.startsWith("-") && arg !== "-") {
      const ok = SED_OPTIONS.has(arg) || (/^-[nEr]+$/.test(arg) && !arg.startsWith("--"));
      if (!ok) return refuse(`\`sed ${arg}\` is not available here.`);
    } else {
      operands.push(arg);
    }
  }
  if (scripts.length === 0) {
    const script = operands.shift();
    if (script === undefined) return refuse("`sed` is missing its script.");
    scripts.push(script);
  }
  const printsOnly = scripts.every((script) =>
    script
      .split(";")
      .filter((part) => part.trim().length > 0)
      .every((part) => SED_PRINT_PART.test(part) || SED_QUIT_PART.test(part)),
  );
  if (!printsOnly)
    return refuse("`sed` may only print line ranges here, such as `sed -n '1,80p'`.");
  return { allowed: true };
}

function hasFlag(args: readonly string[], flags: ReadonlySet<string>): boolean {
  // A one-letter flag can be clustered (`-no out`) or carry its value
  // (`-oout`), so any short-option token holding the letter counts.
  const letters = [...flags].flatMap((flag) => (/^-[A-Za-z0-9]$/.test(flag) ? [flag[1]!] : []));
  return args.some(
    (arg) =>
      flags.has(arg) ||
      flags.has(arg.split("=", 1)[0] ?? arg) ||
      // GNU and Git parsers accept unambiguous long-option abbreviations.
      (arg.startsWith("--") &&
        arg.length > 2 &&
        [...flags].some(
          (flag) => flag.startsWith("--") && flag.startsWith(arg.split("=", 1)[0]!),
        )) ||
      (/^-[^-]/.test(arg) && letters.some((letter) => arg.slice(1).includes(letter))),
  );
}

function positionalCount(
  args: readonly string[],
  valueOptions: ReadonlySet<string>,
  stopAtFirstOperand = false,
): number {
  let count = 0;
  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith("-") && arg !== "-") {
      if (valueOptions.has(arg)) index += 1;
      continue;
    }
    count += 1;
    if (stopAtFirstOperand) optionsEnded = true;
  }
  return count;
}
