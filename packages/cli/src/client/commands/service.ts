import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defaultDataDir } from "../../../../../apps/backend/src/data-dir.js";
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
  return path.resolve(
    stringOption(parsed.options, "data-dir") ??
      context.io.env.ORKESTRATOR_DATA_DIR ??
      defaultDataDir(process.platform, context.io.env),
  );
}

function serveArgs(parsed: ParsedCommand, dataDir: string): string[] {
  const args = parsed.rest.filter((arg) => arg !== "--supervised");
  const error = validateServerArguments(args);
  if (error) throw new CliError("invalid-input", error);
  const hasDataDir = args.some((arg) => arg === "--data-dir" || arg.startsWith("--data-dir="));
  return hasDataDir ? args : [...args, "--data-dir", dataDir];
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
  return { dataDir, layout, manager: selected, unit, unitPath: serviceUnitPath(selected) };
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
      "against the registry) when nothing is installed there yet, points `current` at it,",
      "and writes the unit. It does not start the service: run the printed command.",
    ].join("\n"),
    positionals: [],
    options: OPTIONS,
    acceptsRest: true,
    local: true,
    examples: ["orkestrator service install -- --tailscale-serve"],
    async run(context, parsed) {
      const { dataDir, layout, manager: selected, unit, unitPath } = unitFor(context, parsed);
      const version = context.version;
      if (!existsSync(layout.current)) {
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
