import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { acquireSupervisorLock, dataDirFromArgs } from "../../supervisor/main.js";
import { validateServerArguments } from "../../../../../apps/backend/src/server-flags.js";
import { launcherIn, packageRootIn, runtimeLayout } from "../../supervisor/layout.js";
import {
  defaultServiceManager,
  renderServiceUnit,
  serviceEnableCommands,
  serviceUnitPath,
  type ServiceManager,
} from "../../supervisor/units.js";
import { CliError } from "../errors.js";
import { keyValues } from "../format.js";
import type { CommandContext, CommandSpec, ParsedCommand } from "../spec.js";
import { stringOption } from "./common.js";

function manager(parsed: ParsedCommand): ServiceManager {
  const requested = stringOption(parsed.options, "manager");
  if (requested === undefined) return defaultServiceManager();
  if (requested !== "systemd" && requested !== "launchd") {
    throw new CliError("invalid-input", "--manager must be systemd or launchd");
  }
  return requested;
}

function dataDirectory(context: CommandContext, parsed: ParsedCommand): string {
  const explicit = stringOption(parsed.options, "data-dir");
  const forwarded = dataDirFromArgs(parsed.rest, context.io.env);
  if (
    explicit &&
    parsed.rest.some((arg) => arg === "--data-dir" || arg.startsWith("--data-dir=")) &&
    path.resolve(explicit) !== forwarded
  ) {
    throw new CliError("invalid-input", "Conflicting --data-dir options");
  }
  return explicit ? path.resolve(explicit) : forwarded;
}

function serveArgs(parsed: ParsedCommand, dataDir: string): string[] {
  const args = parsed.rest.filter((arg) => arg !== "--supervised");
  const error = validateServerArguments(args);
  if (error) throw new CliError("invalid-input", error);
  const normalized: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--data-dir") {
      index += 1;
      continue;
    }
    if (!arg.startsWith("--data-dir=")) normalized.push(arg);
  }
  return [...normalized, "--data-dir", dataDir];
}

function unitFor(context: CommandContext, parsed: ParsedCommand) {
  const dataDir = dataDirectory(context, parsed);
  const layout = runtimeLayout(dataDir);
  const selected = manager(parsed);
  const unit = renderServiceUnit({
    manager: selected,
    bunPath: process.execPath,
    launcherPath: launcherIn(packageRootIn(layout.current)),
    dataDir,
    serveArgs: serveArgs(parsed, dataDir),
  });
  return {
    dataDir,
    layout,
    manager: selected,
    unit,
    unitPath: serviceUnitPath(selected, context.io.env.HOME),
  };
}

const OPTIONS: CommandSpec["options"] = [
  {
    name: "manager",
    kind: "string",
    valueName: "systemd|launchd",
    description: "Service manager. Defaults to launchd on macOS and systemd elsewhere.",
  },
  {
    name: "data-dir",
    kind: "string",
    valueName: "DIR",
    description:
      "Backend data directory. Defaults to ORKESTRATOR_DATA_DIR, then the platform default the service uses.",
  },
];

const DESCRIPTION = [
  "The unit runs `orkestrator serve --supervised` from <data-dir>/runtime/current, so the",
  "supervisor that installs updates in place is itself restarted after a reboot or crash.",
  "Pass service flags after `--`; they are checked like `orkestrator serve`'s own.",
].join("\n");

export const serviceCommands: CommandSpec[] = [
  {
    path: ["service", "print"],
    summary: "Print a systemd or launchd unit for the supervised backend.",
    description: DESCRIPTION,
    positionals: [],
    options: OPTIONS,
    acceptsRest: true,
    local: true,
    examples: [
      "orkestrator service print -- --tailscale-serve",
      "orkestrator service print --manager systemd > ~/.config/systemd/user/orkestrator.service",
    ],
    async run(context, parsed) {
      const { unit, manager: selected, unitPath } = unitFor(context, parsed);
      return {
        action: "service.print",
        result: { manager: selected, unitPath, unit },
        human: unit.trimEnd().split("\n"),
      };
    },
  },
  {
    path: ["service", "install"],
    summary: "Install the supervised backend as a user service (prints the command to start it).",
    description: [
      DESCRIPTION,
      "",
      "Installs this CLI's own version into <data-dir>/runtime/versions (verified by Bun",
      "against the registry), resets `current` to it,",
      "and writes the unit. Stop an existing supervisor first. It does not start the service: run the printed command.",
    ].join("\n"),
    positionals: [],
    options: OPTIONS,
    acceptsRest: true,
    local: true,
    examples: ["orkestrator service install -- --tailscale-serve"],
    async run(context, parsed) {
      const { dataDir, layout, manager: selected, unit, unitPath } = unitFor(context, parsed);
      const version = context.version;
      const releaseLock = acquireSupervisorLock(layout.lock);
      try {
        const { createSupervisorRuntime } = await import("../../supervisor/runtime.js");
        const runtime = createSupervisorRuntime({ dataDir, layout, bunPath: process.execPath });
        let installDir: string;
        try {
          installDir = await runtime.stage(version, "");
        } catch (error) {
          throw new CliError(
            "operation-failed",
            `Could not install orkestrator@${version} into ${layout.versions}: ${error instanceof Error ? error.message : String(error)}`,
            { retryable: true },
          );
        }
        await runtime.setCurrent(installDir);
      } finally {
        releaseLock();
      }
      mkdirSync(path.dirname(unitPath), { recursive: true });
      mkdirSync(path.join(dataDir, "logs"), { recursive: true, mode: 0o700 });
      writeFileSync(unitPath, unit, { mode: 0o644 });
      const commands = serviceEnableCommands(selected, unitPath);
      return {
        action: "service.install",
        result: { manager: selected, unitPath, dataDir, start: commands },
        human: [
          ...keyValues([
            ["unit", unitPath],
            ["data directory", dataDir],
          ]),
          "",
          "Start it with:",
          ...commands.map((command) => `  ${command}`),
        ],
      };
    },
  },
];
