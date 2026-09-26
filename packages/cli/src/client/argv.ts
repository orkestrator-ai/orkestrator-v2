import { parsePublicDuration } from "@orkestrator/protocol/public-api";
import { CliError } from "./errors.js";
import type { CommandSpec, GlobalOptions, OptionSpec, ParsedCommand } from "./spec.js";

/**
 * Grammar: `orkestrator [global options] <noun> <verb> [arguments] [options] [-- argv…]`.
 *
 * Command words come first so an option value can never be mistaken for a
 * subcommand. Global options may appear anywhere before `--`. Values use
 * `--name value` or `--name=value`; a value that itself begins with `--`
 * needs the `=` form. Single-valued options may not repeat; list options
 * accumulate. Diagnostics name options and commands but never echo argument
 * values, which may be prompts or other private text.
 */

export const GLOBAL_OPTIONS: readonly OptionSpec[] = [
  {
    name: "connection",
    kind: "string",
    valueName: "NAME",
    description: "Use a saved connection (see `orkestrator connection`).",
  },
  {
    name: "profile",
    kind: "string",
    valueName: "NAME",
    description: "Use a running isolated development profile (`mise run dev:test`).",
  },
  { name: "json", kind: "boolean", description: "Print exactly one JSON envelope on stdout." },
  {
    name: "output",
    kind: "string",
    valueName: "human|json|id",
    description: "Output mode; `id` prints only the documented resource ID.",
  },
  {
    name: "jsonl",
    kind: "boolean",
    description: "Stream one JSON record per line (following commands only).",
  },
  {
    name: "request-timeout",
    kind: "duration",
    valueName: "DURATION",
    description: "Per-request transport deadline (default 60s).",
  },
  { name: "help", kind: "boolean", short: "h", description: "Show help." },
  { name: "version", kind: "boolean", description: "Print the client version." },
];

const SAFE_WORD = /^[a-z][a-z0-9-]{0,39}$/;

function describeToken(token: string): string {
  return SAFE_WORD.test(token) ? `'${token}'` : "argument";
}

export interface CommandTree {
  commands: readonly CommandSpec[];
}

export function isCommandGroup(tree: CommandTree, path: readonly string[]): boolean {
  return tree.commands.some(
    (command) =>
      command.path.length > path.length &&
      path.every((word, index) => command.path[index] === word),
  );
}

export function findCommand(tree: CommandTree, path: readonly string[]): CommandSpec | undefined {
  return tree.commands.find(
    (command) =>
      command.path.length === path.length &&
      command.path.every((word, index) => word === path[index]),
  );
}

/**
 * Best-effort output-mode discovery that works even when the rest of the
 * command line is invalid, so a JSON caller gets a JSON error envelope.
 */
export function sniffOutputMode(argv: readonly string[]): GlobalOptions["output"] {
  let mode: GlobalOptions["output"] = "human";
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--") break;
    if (token === "--json") mode = "json";
    else if (token === "--jsonl") mode = "jsonl";
    else if (token === "--output" && argv[index + 1] === "json") mode = "json";
    else if (token === "--output=json") mode = "json";
    else if (token === "--output" && argv[index + 1] === "id") mode = mode === "json" ? mode : "id";
    else if (token === "--output=id") mode = mode === "json" ? mode : "id";
  }
  return mode;
}

interface OptionState {
  values: Record<string, unknown>;
  seen: Set<string>;
}

function parseOptionValue(spec: OptionSpec, raw: string, flag: string): unknown {
  switch (spec.kind) {
    case "string":
    case "list":
      return raw;
    case "integer": {
      if (!/^-?[0-9]{1,15}$/.test(raw)) {
        throw new CliError("invalid-input", `${flag} expects an integer`);
      }
      return Number(raw);
    }
    case "duration": {
      const value = parsePublicDuration(raw);
      if (value === null) {
        throw new CliError("invalid-input", `${flag} expects a duration such as 30s, 5m or 2h`);
      }
      return value;
    }
    case "boolean":
      throw new CliError("invalid-input", `${flag} does not take a value`);
  }
}

function applyOption(
  state: OptionState,
  spec: OptionSpec,
  flag: string,
  value: unknown,
  commandLabel: string,
): void {
  if (spec.kind === "list") {
    const list = (state.values[spec.name] as unknown[] | undefined) ?? [];
    list.push(value);
    state.values[spec.name] = list;
    return;
  }
  if (state.seen.has(spec.name)) {
    throw new CliError("invalid-input", `${flag} was given more than once for ${commandLabel}`);
  }
  state.seen.add(spec.name);
  state.values[spec.name] = value;
}

export interface ParsedInvocation {
  global: GlobalOptions;
  /** The recognized command, or undefined for bare help/version/group help. */
  command?: ParsedCommand;
  /** Words recognized as a command path (for help). */
  path: string[];
}

/**
 * Parse a client command line. Throws `CliError` for anything invalid;
 * callers render it in the sniffed output mode.
 */
export function parseInvocation(tree: CommandTree, argv: readonly string[]): ParsedInvocation {
  const separator = argv.indexOf("--");
  const head = separator >= 0 ? argv.slice(0, separator) : [...argv];
  const rest = separator >= 0 ? argv.slice(separator + 1) : [];

  const globalState: OptionState = { values: {}, seen: new Set() };
  const commandState: OptionState = { values: {}, seen: new Set() };
  const globalByName = new Map(GLOBAL_OPTIONS.map((option) => [option.name, option]));
  const globalByShort = new Map(
    GLOBAL_OPTIONS.filter((option) => option.short).map((option) => [option.short!, option]),
  );

  // Phase 1: the command path is the leading run of words that extends a
  // known group or command. Global options may be interleaved.
  const path: string[] = [];
  let index = 0;
  const consumeGlobal = (token: string, label: string): boolean => {
    if (token.startsWith("--")) {
      const [flagName, inline] = splitFlag(token);
      const spec = globalByName.get(flagName);
      if (!spec) return false;
      consumeValue(spec, `--${flagName}`, inline, globalState, label);
      return true;
    }
    if (/^-[a-zA-Z]$/.test(token)) {
      const spec = globalByShort.get(token.slice(1));
      if (!spec) return false;
      applyOption(globalState, spec, token, true, label);
      return true;
    }
    return false;
  };
  const consumeValue = (
    spec: OptionSpec,
    flag: string,
    inline: string | undefined,
    state: OptionState,
    label: string,
  ): void => {
    if (spec.kind === "boolean") {
      if (inline !== undefined)
        throw new CliError("invalid-input", `${flag} does not take a value`);
      applyOption(state, spec, flag, true, label);
      return;
    }
    let raw = inline;
    if (raw === undefined) {
      const next = head[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new CliError("invalid-input", `${flag} requires a value`);
      }
      raw = next;
      index += 1;
    }
    applyOption(state, spec, flag, parseOptionValue(spec, raw, flag), label);
  };

  for (; index < head.length; index += 1) {
    const token = head[index]!;
    if (token.startsWith("-")) {
      if (consumeGlobal(token, "this command")) continue;
      break;
    }
    const candidate = [...path, token];
    if (findCommand(tree, candidate) || isCommandGroup(tree, candidate)) {
      path.push(token);
      if (findCommand(tree, path) && !isCommandGroup(tree, path)) {
        index += 1;
        break;
      }
      continue;
    }
    break;
  }

  const command = findCommand(tree, path);
  const label = path.length > 0 ? `'${path.join(" ")}'` : "orkestrator";
  const optionsByName = new Map((command?.options ?? []).map((option) => [option.name, option]));
  const positionals: string[] = [];

  // Phase 2: remaining arguments and options.
  for (; index < head.length; index += 1) {
    const token = head[index]!;
    if (token.startsWith("--")) {
      const [flagName, inline] = splitFlag(token);
      const globalSpec = globalByName.get(flagName);
      if (globalSpec) {
        consumeValue(globalSpec, `--${flagName}`, inline, globalState, label);
        continue;
      }
      let spec = optionsByName.get(flagName);
      if (spec) {
        consumeValue(spec, `--${flagName}`, inline, commandState, label);
        continue;
      }
      if (flagName.startsWith("no-")) {
        spec = optionsByName.get(flagName.slice(3));
        if (spec?.negatable && spec.kind === "boolean") {
          if (inline !== undefined) {
            throw new CliError("invalid-input", `--${flagName} does not take a value`);
          }
          applyOption(commandState, spec, `--${flagName}`, false, label);
          continue;
        }
      }
      throw new CliError(
        "unknown-option",
        `Unknown option --${SAFE_WORD.test(flagName) ? flagName : "…"} for ${label}`,
      );
    }
    if (/^-[a-zA-Z]$/.test(token)) {
      if (consumeGlobal(token, label)) continue;
      throw new CliError("unknown-option", `Unknown option ${token} for ${label}`);
    }
    positionals.push(token);
  }

  const global: GlobalOptions = {
    output: "human",
    help: globalState.values.help === true,
    version: globalState.values.version === true,
  };
  if (typeof globalState.values.connection === "string") {
    global.connection = globalState.values.connection;
  }
  if (typeof globalState.values.profile === "string") global.profile = globalState.values.profile;
  if (global.connection && global.profile) {
    throw new CliError(
      "invalid-input",
      "--connection and --profile select different backends; pass only one",
    );
  }
  if (typeof globalState.values["request-timeout"] === "number") {
    global.requestTimeoutMs = globalState.values["request-timeout"] as number;
  }
  const modes: GlobalOptions["output"][] = [];
  if (globalState.values.json === true) modes.push("json");
  if (globalState.values.jsonl === true) modes.push("jsonl");
  if (typeof globalState.values.output === "string") {
    const output = globalState.values.output;
    if (output !== "human" && output !== "json" && output !== "id") {
      throw new CliError("invalid-input", "--output must be human, json or id");
    }
    modes.push(output);
  }
  if (new Set(modes).size > 1) {
    throw new CliError("invalid-input", "--json, --jsonl and --output are mutually exclusive");
  }
  global.output = modes[0] ?? "human";

  if (global.help || global.version) return { global, path };
  if (!command) {
    if (path.length === 0 && positionals.length === 0 && rest.length === 0) {
      return { global, path };
    }
    if (path.length > 0 && isCommandGroup(tree, path) && positionals.length === 0) {
      throw new CliError(
        "unknown-command",
        `${label} needs a subcommand; see \`orkestrator help ${path.join(" ")}\``,
        {
          details: { path },
        },
      );
    }
    const word = positionals[0] ?? "";
    throw new CliError(
      "unknown-command",
      `Unknown command ${describeToken(word)}${path.length > 0 ? ` for ${label}` : ""}`,
    );
  }

  if (rest.length > 0 && !command.acceptsRest) {
    throw new CliError("invalid-input", `${label} does not accept arguments after --`);
  }
  if (global.output === "id" && !command.idOutput) {
    throw new CliError("invalid-input", `${label} does not support --output id`);
  }
  if (global.output === "jsonl" && !command.jsonl) {
    throw new CliError("invalid-input", `${label} does not support --jsonl`);
  }

  const bound: Record<string, string | string[] | undefined> = {};
  let cursor = 0;
  for (const positional of command.positionals) {
    if (positional.variadic) {
      bound[positional.name] = positionals.slice(cursor);
      cursor = positionals.length;
      if (positional.required && (bound[positional.name] as string[]).length === 0) {
        throw new CliError("invalid-input", `${label} requires <${positional.name}>`);
      }
      continue;
    }
    const value = positionals[cursor];
    if (value === undefined) {
      if (positional.required) {
        throw new CliError("invalid-input", `${label} requires <${positional.name}>`);
      }
      continue;
    }
    bound[positional.name] = value;
    cursor += 1;
  }
  if (cursor < positionals.length) {
    throw new CliError("invalid-input", `Too many arguments for ${label}`);
  }

  return {
    global,
    path,
    command: { spec: command, positionals: bound, options: commandState.values, rest },
  };
}

function splitFlag(token: string): [string, string | undefined] {
  const body = token.slice(2);
  const equals = body.indexOf("=");
  if (equals < 0) return [body, undefined];
  return [body.slice(0, equals), body.slice(equals + 1)];
}
