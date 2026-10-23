import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";
import { defaultDataDir } from "../../../../../apps/backend/src/data-dir.js";
import { CliError } from "../errors.js";
import { keyValues } from "../format.js";
import {
  awaitServiceConnection,
  currentDescriptorGeneration,
  type ServiceConnection,
} from "../service-connection.js";
import { askServeArguments } from "../service-setup.js";
import { serviceManagerCommands, serviceUnit } from "../service-units.js";
import type { CommandContext, CommandSpec, ParsedCommand } from "../spec.js";
import { stringOption } from "./common.js";
import { throwIfInterrupted } from "../wait.js";

/**
 * `service install | uninstall | status`: run a standalone backend under
 * launchd (macOS) or systemd (Linux), from versioned releases it can update
 * itself between (see `@orkestrator/protocol/node/standalone-service`).
 */

const DATA_DIR_OPTION = {
  name: "data-dir",
  kind: "string" as const,
  valueName: "DIR",
  description:
    "Backend data directory. Defaults to ORKESTRATOR_DATA_DIR, then the platform default.",
};

/**
 * How long `service install` waits for the backend to start before printing its
 * address and token. A first start installs the agent toolchain, so this is
 * generous; the service keeps starting after it passes.
 */
const DEFAULT_READY_WAIT_MS = 3 * 60 * 1000;

/** Flags the launcher owns; the service passes its own. */
const RESERVED_SERVE_FLAGS = new Set(["--data-dir", "--standalone-updater", "--desktop-updater"]);

function dataDirectory(context: CommandContext, parsed: ParsedCommand): string {
  return path.resolve(
    stringOption(parsed.options, "data-dir") ??
      context.io.env.ORKESTRATOR_DATA_DIR ??
      defaultDataDir(process.platform, context.io.env),
  );
}

/** `service install` with the options this run was given, for the setup summary. */
function installCommandLine(parsed: ParsedCommand): string[] {
  const line = ["bunx", "orkestrator", "service", "install"];
  for (const name of ["data-dir", "release", "timeout"]) {
    const value = parsed.options[name];
    if (typeof value === "string") line.push(`--${name}`, value);
    else if (typeof value === "number") line.push(`--${name}`, `${Math.ceil(value / 1000)}s`);
  }
  for (const name of ["skip-start", "dry-run"]) {
    if (parsed.options[name] === true) line.push(`--${name}`);
  }
  line.push("--yes");
  return line;
}

function unitFor(context: CommandContext, dataDir: string, bun: string) {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new CliError("unsupported", "Services are supported on macOS and Linux only");
  }
  return import("@orkestrator/protocol/node/standalone-service").then((service) => {
    const layout = service.standaloneLayout(dataDir);
    return {
      service,
      layout,
      unit: serviceUnit({
        platform: process.platform,
        dataDir,
        defaultDataDir: defaultDataDir(process.platform, context.io.env),
        bun,
        launcher: layout.launcher,
        logFile: path.join(layout.logs, "service.log"),
        env: context.io.env,
      }),
    };
  });
}

function runManager(argv: string[], allowFailure = false): { ok: boolean; output: string } {
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 60_000 });
  const ok = result.status === 0;
  if (!ok && !allowFailure) {
    throw new CliError(
      "operation-failed",
      `${argv.join(" ")} failed: ${(result.stderr || result.stdout || "").trim().slice(0, 300)}`,
    );
  }
  return { ok, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

export const serviceCommands: CommandSpec[] = [
  {
    path: ["service", "install"],
    summary: "Run a standalone backend as a launchd or systemd user service that updates itself.",
    description: [
      "Installs orkestrator@VERSION (--release; default: this client's version) with its dependencies into",
      "<data-dir>/backend/releases/VERSION, points `current` at it, and writes a service unit",
      "that runs the release through a small launcher. The launcher installs each release's",
      "pinned toolchain, restarts the backend when it updates itself, and goes back to the",
      "previous release when a new one fails to start twice.",
      "",
      "Arguments after `--` are passed to `orkestrator serve` (for example `--tailscale-serve`).",
      "With none, in a terminal, it asks how clients will connect (Tailscale Serve, the",
      "tailnet address or SSH) and prints the equivalent command; --yes skips the questions.",
      "The Bun running this command is the Bun the service uses; reinstall to change it.",
      "On Linux, run `loginctl enable-linger $USER` so the service runs without a login.",
      "",
      "Once the service is running, the address it serves and its gateway token are printed.",
      "The token is shown only in this terminal: never in --output json or the service log.",
    ].join("\n"),
    positionals: [],
    options: [
      DATA_DIR_OPTION,
      {
        name: "release",
        kind: "string",
        valueName: "VERSION",
        description: "Release to install from npm. Defaults to this client's version.",
      },
      {
        name: "skip-start",
        kind: "boolean",
        description: "Write the release and unit, but do not load the unit.",
      },
      {
        name: "dry-run",
        kind: "boolean",
        description: "Show what would be written without installing anything.",
      },
      {
        name: "yes",
        kind: "boolean",
        description: "Install with the arguments after `--` (or none) without asking.",
      },
      {
        name: "timeout",
        kind: "duration",
        valueName: "DURATION",
        description:
          "How long to wait for the service to start before printing its address and token. Default 3m; 0 skips the wait.",
      },
    ],
    acceptsRest: true,
    local: true,
    examples: [
      "orkestrator service install",
      "orkestrator service install -- --tailscale-serve",
      "orkestrator service install --release 2.22.0 -- --host 100.64.0.1",
      "orkestrator service install --dry-run",
    ],
    async run(context, parsed) {
      const dataDir = dataDirectory(context, parsed);
      const version = stringOption(parsed.options, "release") ?? context.version;
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
        throw new CliError("invalid-input", `--release ${version} is not a release version`);
      }
      const reserved = parsed.rest.find((arg) => RESERVED_SERVE_FLAGS.has(arg.split("=")[0]!));
      if (reserved) {
        throw new CliError("invalid-input", `${reserved} is set by the service; leave it out`);
      }
      const interactive =
        parsed.rest.length === 0 &&
        parsed.options.yes !== true &&
        context.global.output === "human" &&
        context.io.stdinIsTty &&
        context.io.question !== undefined;
      const readyWaitMs =
        typeof parsed.options.timeout === "number" ? parsed.options.timeout : DEFAULT_READY_WAIT_MS;
      if (readyWaitMs > PUBLIC_API_LIMITS.waitMaxMs) {
        throw new CliError("invalid-input", "--timeout may be at most 24h");
      }
      const serveArgs = interactive
        ? await askServeArguments(context.io, {
            installCommand: installCommandLine(parsed),
            signal: context.signal,
          })
        : parsed.rest;
      const bun = process.execPath;
      const bunVersion = typeof Bun === "undefined" ? "" : Bun.version;
      const { service, layout, unit } = await unitFor(context, dataDir, bun);
      const summary = {
        dataDir,
        version,
        bun,
        bunVersion,
        args: serveArgs,
        unit: { manager: unit.manager, name: unit.name, file: unit.file },
        release: service.releaseDirectory(layout, version),
      };
      if (parsed.options["dry-run"] === true) {
        return {
          action: "service.install",
          result: { dryRun: true, ...summary, unitContents: unit.contents },
          human: [
            ...keyValues([
              ["data directory", dataDir],
              ["release", `${version} → ${summary.release}`],
              ["bun", `${bun} (${bunVersion})`],
              ["unit", `${unit.manager} ${unit.name} → ${unit.file}`],
              ["serve arguments", serveArgs.join(" ") || "(none)"],
            ]),
            "",
            "Dry run: nothing was installed.",
          ],
        };
      }
      context.io.stderr(`Installing orkestrator@${version}…\n`);
      throwIfInterrupted(context.signal);
      let releaseDir: string;
      try {
        releaseDir = await service.installRelease(layout, version, { bun });
      } catch (error) {
        throw new CliError(
          "operation-failed",
          `Could not install orkestrator@${version}: ${error instanceof Error ? error.message : String(error)}`,
          { retryable: true },
        );
      }
      await service.installLauncher(layout, releaseDir);
      await service.activateRelease(layout, version);
      await service.writeServiceConfig(layout, {
        version: 1,
        dataDir,
        bun,
        bunVersion,
        args: serveArgs,
        installedAt: new Date().toISOString(),
      });
      await mkdir(layout.logs, { recursive: true });
      await mkdir(path.dirname(unit.file), { recursive: true });
      await writeFile(unit.file, unit.contents);
      const started = parsed.options["skip-start"] !== true;
      const logFile = path.join(layout.logs, "service.log");
      let connection: ServiceConnection | null = null;
      if (started) {
        // A backend already serving this data directory (a reinstall) is
        // replaced; only a new generation's descriptor describes this install.
        const previousGeneration = await currentDescriptorGeneration(dataDir);
        const commands = serviceManagerCommands(unit);
        commands.load.forEach((argv, index) =>
          // Unloading an absent launchd job fails; that first step is best effort.
          runManager(argv, unit.manager === "launchd" && index === 0),
        );
        if (readyWaitMs > 0) {
          context.io.stderr("Waiting for the backend to start…\n");
          connection = await awaitServiceConnection(dataDir, previousGeneration, {
            timeoutMs: readyWaitMs,
            signal: context.signal,
          });
        }
      }
      return {
        action: "service.install",
        // The token stays out of the machine-readable result.
        result: {
          dryRun: false,
          started,
          ready: connection !== null,
          browserUrl: connection?.browserUrl ?? null,
          authFile: connection?.authFile ?? null,
          ...(connection?.credentialError ? { credentialError: connection.credentialError } : {}),
          ...summary,
        },
        human: [
          ...keyValues([
            ["release", `${version} (${releaseDir})`],
            ["unit", `${unit.manager} ${unit.name}`],
            ["logs", logFile],
          ]),
          "",
          started
            ? "The service is running. Remote clients can update it from Settings → Machines or `orkestrator host update`."
            : `The unit is written but not loaded; load it with: ${serviceManagerCommands(unit).load.at(-1)!.join(" ")}`,
          ...(connection
            ? [
                "",
                ...keyValues([
                  ["address", connection.browserUrl ?? "(no browser listener; see the log)"],
                  ["auth file", connection.authFile],
                  ...(context.io.stdoutIsTty &&
                  context.global.output === "human" &&
                  connection.token
                    ? [["token", connection.token] as [string, string]]
                    : []),
                ]),
                ...(connection.credentialError
                  ? [`Credential file error: ${connection.credentialError}`]
                  : context.io.stdoutIsTty && context.global.output === "human"
                    ? ["Keep the token private: it grants full access to this backend."]
                    : ["Read the gateway token locally from the private auth file."]),
              ]
            : started && readyWaitMs > 0
              ? [
                  "",
                  `The backend has not reported ready yet. Follow ${logFile}; its address and token file are logged there.`,
                ]
              : []),
          ...(unit.manager === "systemd"
            ? ["Run `loginctl enable-linger $USER` so it keeps running after you log out."]
            : []),
        ],
      };
    },
  },
  {
    path: ["service", "uninstall"],
    summary: "Stop and remove the standalone backend service.",
    positionals: [],
    options: [
      DATA_DIR_OPTION,
      {
        name: "purge",
        kind: "boolean",
        description: "Also delete the installed releases (the data directory itself is kept).",
      },
    ],
    local: true,
    async run(context, parsed) {
      const dataDir = dataDirectory(context, parsed);
      const { service, layout, unit } = await unitFor(context, dataDir, process.execPath);
      const config = service.readServiceConfig(layout);
      if (existsSync(unit.file)) {
        for (const argv of serviceManagerCommands(unit).unload) runManager(argv, true);
        await rm(unit.file, { force: true });
      }
      if (parsed.options.purge === true) await rm(layout.root, { recursive: true, force: true });
      return {
        action: "service.uninstall",
        result: { dataDir, unit: unit.name, removed: true, purged: parsed.options.purge === true },
        human: [
          `Removed ${unit.manager} ${unit.name}${config ? "" : " (it was not installed here)"}.`,
          parsed.options.purge === true
            ? `Deleted ${layout.root}.`
            : `Releases are kept in ${layout.releases}; pass --purge to delete them.`,
        ],
      };
    },
  },
  {
    path: ["service", "status"],
    summary:
      "Show the standalone backend service: its releases, launcher state and whether it runs.",
    positionals: [],
    options: [DATA_DIR_OPTION],
    local: true,
    async run(context, parsed) {
      const dataDir = dataDirectory(context, parsed);
      const { service, layout, unit } = await unitFor(context, dataDir, process.execPath);
      const config = service.readServiceConfig(layout);
      const state = service.readLauncherState(layout);
      const installed = existsSync(unit.file);
      const running = installed ? runManager(serviceManagerCommands(unit).status, true).ok : false;
      const result = {
        dataDir,
        installed,
        running,
        unit: { manager: unit.manager, name: unit.name, file: unit.file },
        current: service.linkedVersion(layout.current),
        previous: service.linkedVersion(layout.previous),
        bun: config?.bun ?? null,
        args: config?.args ?? [],
        lastReadyVersion: state.lastReadyVersion,
        rollback: state.rollback,
      };
      return {
        action: "service.status",
        result,
        human: keyValues([
          [
            "unit",
            `${unit.manager} ${unit.name} (${installed ? (running ? "running" : "not running") : "not installed"})`,
          ],
          ["current", result.current ?? "none"],
          ["previous", result.previous ?? "none"],
          ["last ready", result.lastReadyVersion ?? "none"],
          [
            "last rollback",
            result.rollback
              ? `${result.rollback.failedVersion} → ${result.rollback.restoredVersion} at ${result.rollback.at}`
              : "none",
          ],
        ]),
      };
    },
  },
];
