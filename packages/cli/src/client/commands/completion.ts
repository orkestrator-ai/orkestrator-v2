import { GLOBAL_OPTIONS } from "../argv.js";
import { CliError } from "../errors.js";
import type { CommandSpec } from "../spec.js";

/**
 * `orkestrator completion bash|zsh|fish` prints a completion script built
 * from the command table, so it can never drift from the commands this build
 * has. It completes nouns, verbs and flags only: it never contacts a backend,
 * so IDs are not completed.
 */

const SHELLS = ["bash", "zsh", "fish"] as const;
type Shell = (typeof SHELLS)[number];

interface CompletionTable {
  /** Space-joined command-path prefix → the words that may follow it. */
  next: Map<string, string[]>;
  /** Space-joined full command path → its flags. */
  flags: Map<string, string[]>;
  globals: string[];
  values: Map<string, string[]>;
}

function flagsOf(options: readonly CommandSpec["options"][number][]): string[] {
  return options.flatMap((option) => [
    `--${option.name}`,
    ...(option.short ? [`-${option.short}`] : []),
    ...(option.negatable ? [`--no-${option.name}`] : []),
  ]);
}

export function completionTable(commands: readonly CommandSpec[]): CompletionTable {
  const next = new Map<string, string[]>();
  const flags = new Map<string, string[]>();
  const values = new Map<string, string[]>();
  const valueFlags = (options: readonly CommandSpec["options"][number][]) =>
    flagsOf(options.filter((option) => option.kind !== "boolean"));
  values.set("", valueFlags(GLOBAL_OPTIONS));
  const add = (prefix: string, word: string) => {
    const words = next.get(prefix) ?? [];
    if (!words.includes(word)) words.push(word);
    next.set(prefix, words);
  };
  for (const command of commands) {
    command.path.forEach((word, index) => {
      const prefix = command.path.slice(0, index).join(" ");
      add(prefix, word);
      if (!values.has(prefix)) values.set(prefix, valueFlags(GLOBAL_OPTIONS));
    });
    flags.set(command.path.join(" "), flagsOf(command.options));
    values.set(command.path.join(" "), [
      ...valueFlags(GLOBAL_OPTIONS),
      ...valueFlags(command.options),
    ]);
  }
  add("", "help");
  add("", "version");
  return { next, flags, globals: flagsOf(GLOBAL_OPTIONS), values };
}

/** Command and flag names are plain ASCII words, safe unquoted in each shell. */
function words(list: readonly string[]): string {
  return list.join(" ");
}

function bashScript(table: CompletionTable): string {
  const cases = [...table.next].map(
    ([prefix, list]) => `    "${prefix}") echo "${words(list)}" ;;`,
  );
  const flagCases = [...table.flags].map(
    ([path, list]) => `    "${path}") flags="${words(list)}" ;;`,
  );
  return [
    "# orkestrator bash completion. Install: orkestrator completion bash > ~/.local/share/bash-completion/completions/orkestrator",
    "_orkestrator_next() {",
    '  case "$1" in',
    ...cases,
    "  esac",
    "}",
    "_orkestrator_takes_value() {",
    '  case "$1:$2" in',
    ...[...table.values]
      .filter(([, flags]) => flags.length)
      .map(
        ([path, flags]) => `    ${flags.map((flag) => `"${path}:${flag}"`).join("|")}) return 0 ;;`,
      ),
    "  esac",
    "  return 1",
    "}",
    "_orkestrator() {",
    '  local cur="${COMP_WORDS[COMP_CWORD]}" command_path="" word i flags="" skip=0',
    "  COMPREPLY=()",
    "  for ((i = 1; i < COMP_CWORD; i++)); do",
    '    word="${COMP_WORDS[i]}"',
    '    if ((skip)); then [[ "$word" == "=" ]] || skip=0; continue; fi',
    '    [[ "$word" == "--" ]] && return 0',
    '    [[ "$word" == --*=* ]] && continue',
    '    if _orkestrator_takes_value "$command_path" "$word"; then skip=1; continue; fi',
    '    [[ "$word" == -* ]] && continue',
    // Only command words extend the path; IDs and other arguments do not.
    '    if [[ " $(_orkestrator_next "$command_path") " == *" $word "* ]]; then command_path="${command_path:+$command_path }$word"; fi',
    "  done",
    "  ((skip)) && return 0",
    '  case "$command_path" in',
    ...flagCases,
    "  esac",
    "  local candidates candidate",
    '  if [[ "$cur" == -* ]]; then',
    `    candidates="$flags ${words(table.globals)}"`,
    "  else",
    '    candidates="$(_orkestrator_next "$command_path")"',
    "  fi",
    "  for candidate in $candidates; do",
    '    [[ "$candidate" == "$cur"* ]] && COMPREPLY+=("$candidate")',
    "  done",
    "  return 0",
    "}",
    "complete -o default -F _orkestrator orkestrator",
    "",
  ].join("\n");
}

function zshScript(table: CompletionTable): string {
  return [
    "#compdef orkestrator",
    '# orkestrator zsh completion (through bashcompinit). Install: orkestrator completion zsh > "${fpath[1]}/_orkestrator"',
    "autoload -U +X bashcompinit && bashcompinit",
    bashScript(table)
      .split("\n")
      .slice(1)
      .join("\n")
      .replace("_orkestrator() {\n", "_orkestrator() {\n  emulate -L ksh\n"),
  ].join("\n");
}

function fishScript(table: CompletionTable): string {
  const lines = [
    "# orkestrator fish completion. Install: orkestrator completion fish > ~/.config/fish/completions/orkestrator.fish",
    "function __orkestrator_next",
    "  switch $argv[1]",
    ...[...table.next].map(([prefix, list]) => `    case '${prefix}'\n      echo '${words(list)}'`),
    "  end",
    "end",
    "function __orkestrator_takes_value",
    '  switch "$argv[1]:$argv[2]"',
    ...[...table.values]
      .filter(([, flags]) => flags.length)
      .map(
        ([path, flags]) =>
          `    case ${flags.map((flag) => `'${path}:${flag}'`).join(" ")}\n      return 0`,
      ),
    "  end",
    "  return 1",
    "end",
    "function __orkestrator_path",
    "  set -l tokens (commandline -opc)",
    "  set -e tokens[1]",
    "  set -l path ''",
    "  set -l skip 0",
    "  for token in $tokens",
    "    if test $skip = 1",
    "      set skip 0",
    "      continue",
    "    end",
    '    if test "$token" = "--"',
    "      echo __rest",
    "      return",
    "    end",
    "    string match -q -- '--*=*' $token; and continue",
    '    if __orkestrator_takes_value "$path" "$token"',
    "      set skip 1",
    "      continue",
    "    end",
    "    string match -q -- '-*' $token; and continue",
    "    if contains -- $token (string split ' ' -- (__orkestrator_next $path))",
    '      set path (string trim -- "$path $token")',
    "    end",
    "  end",
    "  if test $skip = 1",
    "    echo __value",
    "    return",
    "  end",
    '  echo "$path"',
    "end",
    "complete -c orkestrator -f",
  ];
  for (const [prefix, list] of table.next) {
    lines.push(
      `complete -c orkestrator -n 'test (__orkestrator_path) = "${prefix}"' -a '${words(list)}'`,
    );
  }
  for (const [path, list] of table.flags) {
    for (const flag of list) {
      lines.push(
        `complete -c orkestrator -n 'test (__orkestrator_path) = "${path}"' ${flag.startsWith("--") ? `-l '${flag.slice(2)}'` : `-s '${flag.slice(1)}'`}${table.values.get(path)?.includes(flag) ? " -r" : ""}`,
      );
    }
  }
  for (const flag of table.globals) {
    lines.push(
      `complete -c orkestrator ${flag.startsWith("--") ? `-l '${flag.slice(2)}'` : `-s '${flag.slice(1)}'`}${table.values.get("")?.includes(flag) ? " -r" : ""}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function completionScript(shell: Shell, commands: readonly CommandSpec[]): string {
  const table = completionTable(commands);
  return shell === "bash"
    ? bashScript(table)
    : shell === "zsh"
      ? zshScript(table)
      : fishScript(table);
}

/** `commands` is read lazily: the table includes this command itself. */
export function completionCommands(commands: () => readonly CommandSpec[]): CommandSpec[] {
  return [
    {
      path: ["completion"],
      summary: "Print a shell completion script (bash, zsh or fish).",
      description:
        "Completes nouns, verbs and flags from this build's command table; it never contacts a backend, so IDs are not completed. Example: `orkestrator completion bash > ~/.local/share/bash-completion/completions/orkestrator`.",
      positionals: [{ name: "shell", required: true, description: "bash, zsh or fish." }],
      options: [],
      local: true,
      async run(_context, parsed) {
        const shell = parsed.positionals.shell;
        if (!SHELLS.includes(shell as Shell)) {
          throw new CliError("invalid-input", "Shell must be one of: bash, zsh, fish");
        }
        const script = completionScript(shell as Shell, commands());
        return {
          action: "completion",
          result: { shell, script },
          human: [script.replace(/\n$/, "")],
        };
      },
    },
  ];
}
