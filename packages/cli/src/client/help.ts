import { GLOBAL_OPTIONS, isCommandGroup, type CommandTree } from "./argv.js";
import type { CommandSpec, OptionSpec } from "./spec.js";

const GROUP_SUMMARIES: Record<string, string> = {
  connection: "Select and verify the backend this client talks to.",
  project: "Register, create, edit and remove projects.",
  environment: "Create, start, stop, configure, launch and delete environments.",
  agent: "Discover agents, models and controls.",
  session: "Start, prompt, control and inspect native-agent conversations.",
  run: "Inspect, wait for and recover individual operations.",
};

function optionLine(option: OptionSpec): string {
  const flag = `--${option.name}${option.kind === "boolean" ? "" : ` ${option.valueName ?? "VALUE"}`}`;
  const negation = option.negatable ? ` / --no-${option.name}` : "";
  const short = option.short ? `-${option.short}, ` : "";
  return `  ${`${short}${flag}${negation}`.padEnd(34)} ${option.description}${option.kind === "list" ? " (repeatable)" : ""}`;
}

function usage(command: CommandSpec): string {
  const positionals = command.positionals
    .map((positional) => {
      const name = `${positional.name.toUpperCase()}${positional.variadic ? "…" : ""}`;
      return positional.required ? name : `[${name}]`;
    })
    .join(" ");
  return `orkestrator ${command.path.join(" ")}${positionals ? ` ${positionals}` : ""}${command.options.length ? " [options]" : ""}${command.acceptsRest ? " -- ARGV…" : ""}`;
}

export function commandHelp(command: CommandSpec): string {
  return [
    `Usage: ${usage(command)}`,
    "",
    command.summary,
    ...(command.description ? ["", command.description] : []),
    ...(command.options.length ? ["", "Options:", ...command.options.map(optionLine)] : []),
    ...(command.idOutput ? ["", `--output id prints: ${command.idOutput}`] : []),
    ...(command.examples?.length
      ? ["", "Examples:", ...command.examples.map((line) => `  ${line}`)]
      : []),
    "",
    "Global options: --connection NAME | --profile NAME, --json, --output human|json|id, --request-timeout DURATION",
  ].join("\n");
}

export function groupHelp(tree: CommandTree, path: string[]): string {
  const children = tree.commands.filter(
    (command) =>
      command.path.length > path.length &&
      path.every((word, index) => command.path[index] === word),
  );
  return [
    `Usage: orkestrator ${path.join(" ")} <command> [options]`,
    "",
    GROUP_SUMMARIES[path[0]!] ?? "",
    "",
    "Commands:",
    ...children.map(
      (command) => `  ${command.path.slice(path.length).join(" ").padEnd(24)} ${command.summary}`,
    ),
    "",
    `Run \`orkestrator help ${path.join(" ")} <command>\` for details.`,
  ].join("\n");
}

export function rootHelp(tree: CommandTree): string {
  const groups = [...new Set(tree.commands.map((command) => command.path[0]!))];
  return [
    "Usage:",
    "  orkestrator [serve] [service options]     Run the backend service in the foreground",
    "  orkestrator <group> <command> [options]   Talk to an already-running backend",
    "",
    "Client commands never start a backend. Select the backend explicitly with",
    "--profile NAME (an isolated dev profile) or --connection NAME, or save a",
    "default with `orkestrator connection default NAME`.",
    "",
    "Groups:",
    ...groups.map((group) => `  ${group.padEnd(14)} ${GROUP_SUMMARIES[group] ?? ""}`),
    "",
    "Other:",
    "  serve          Run the backend service (same as passing only service options)",
    "  help [COMMAND] Show help for a group or command",
    "  version        Print the client version",
    "",
    "Global options:",
    ...GLOBAL_OPTIONS.map(optionLine),
    "",
    "Exit codes: 0 ok, 1 operation failed, 2 invalid input, 3 not found/ambiguous/expired,",
    "4 connection/auth, 5 wait deadline, 6 interaction required, 7 unknown dispatch,",
    "8 conflict/unsupported, 130/143 observation interrupted by SIGINT/SIGTERM.",
    "Paths given to project commands are on the BACKEND host; prompt, patch and",
    "credential files are read on this machine.",
  ].join("\n");
}

export function helpFor(tree: CommandTree, path: string[]): string {
  if (path.length === 0) return rootHelp(tree);
  const command = tree.commands.find(
    (candidate) =>
      candidate.path.length === path.length &&
      candidate.path.every((word, index) => word === path[index]),
  );
  if (command && !isCommandGroup(tree, path)) return commandHelp(command);
  return groupHelp(tree, path);
}

export const SERVE_HELP = [
  "Usage: orkestrator [serve] [service options]",
  "",
  "Runs the Orkestrator backend in the foreground until SIGINT/SIGTERM.",
  "Bare service options (without `serve`) keep working for existing launchers.",
  "",
  "Common options:",
  "  --host ADDRESS --port PORT       Listener address (use 127.0.0.1 with --allow-non-tailscale-bind)",
  "  --data-dir DIR                   Data directory (default: the platform data directory)",
  "  --tailscale-serve                Publish through Tailscale Serve",
  "  --allowed-origins LIST           Allowed browser origins",
].join("\n");
