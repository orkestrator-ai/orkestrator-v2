import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import type { StandaloneStartupFailure } from "@orkestrator/protocol/node/standalone-service";
import { PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";
import { defaultDataDir, isDefaultDataDir } from "../../../../../apps/backend/src/data-dir.js";
import {
  DEFAULT_CONTROL_MCP_PORT,
  DEFAULT_GATEWAY_PORT,
} from "../../../../../apps/backend/src/fixed-ports.js";
import { CliError } from "../errors.js";
import { keyValues } from "../format.js";
import {
  awaitServiceConnection,
  currentDescriptorGeneration,
  startupLogExcerpt,
  type ServiceConnection,
} from "../service-connection.js";
import { askServeArguments, warnIfTailscaleOperatorNeeded } from "../service-setup.js";
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

async function startupFailedError(
  version: string,
  failure: StandaloneStartupFailure,
  logFile: string,
  logOffset: number,
): Promise<CliError> {
  const excerpt = await startupLogExcerpt(logFile, logOffset, version);
  return new CliError(
    "operation-failed",
    [
      failure.restoredVersion
        ? `orkestrator@${version} did not start, so the service went back to ${failure.restoredVersion}.`
        : `orkestrator@${version} did not start, and the service keeps retrying it.`,
      ...(excerpt.length > 0 ? ["", ...excerpt, ""] : []),
      `Fix the cause, then run this command again. Full log: ${logFile}`,
    ].join("\n"),
    { retryable: true },
  );
}

/** A free loopback port to keep across restarts; the OS may offer a fixed one on Linux. */
export async function freeServicePort(allocate = probeServicePort): Promise<string> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const port = await allocate();
    if (validServicePort(String(port))) return String(port);
  }
  throw new Error("Unable to allocate an unreserved service port");
}

function validServicePort(value: string | undefined): string | undefined {
  const port = Number(value);
  return value !== undefined &&
    String(port) === value &&
    Number.isInteger(port) &&
    port > 0 &&
    port <= 65535 &&
    port !== DEFAULT_GATEWAY_PORT &&
    port !== DEFAULT_CONTROL_MCP_PORT
    ? value
    : undefined;
}

async function probeServicePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

/** The `--port` value in serve arguments, if any. */
function portArgument(args: readonly string[] | undefined): string | undefined {
  const index = args?.indexOf("--port") ?? -1;
  return index >= 0 ? args?.[index + 1] : undefined;
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
      "",
      "Only the default data directory's backend uses the fixed gateway port. With another",
      "--data-dir and no `--port`, the backend takes a free port that changes on each start,",
      "so pass `-- --port PORT` for a stable address. --tailscale-serve gets a free port",
      "chosen once, here, with strict binding so it cannot move to a fallback port.",
      "On Linux, run `loginctl enable-linger $USER` so the service runs without a login.",
      "",
      "Once the service is running, the address it serves and its gateway token are printed.",
      "The token is shown only in this terminal: never in --output json or the service log.",
      "If the release cannot start, the command fails with what the service logged.",
      "",
      "On Linux, --tailscale-serve needs `sudo tailscale set --operator=$USER` once; the",
      "questions offer to run it, and a scripted install warns when it is missing.",
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
      const secondBackend = !isDefaultDataDir(dataDir, process.platform, context.io.env);
      const requestedArgs = interactive
        ? await askServeArguments(context.io, {
            installCommand: installCommandLine(parsed),
            signal: context.signal,
            dryRun: parsed.options["dry-run"] === true,
            secondBackend,
          })
        : parsed.rest;
      if (!interactive) warnIfTailscaleOperatorNeeded(context.io, requestedArgs);
      const bun = process.execPath;
      const bunVersion = typeof Bun === "undefined" ? "" : Bun.version;
      const { service, layout, unit } = await unitFor(context, dataDir, bun);
      // Keep the chosen Serve target stable. Strict binding prevents a startup
      // race from moving it to an unrecorded fallback. Durable backend ownership
      // separately recovers older units and an intentional port change.
      const pinsPort =
        secondBackend &&
        requestedArgs.includes("--tailscale-serve") &&
        !requestedArgs.includes("--port");
      const serveArgs =
        pinsPort && parsed.options["dry-run"] !== true
          ? [
              ...requestedArgs,
              "--port",
              validServicePort(portArgument(service.readServiceConfig(layout)?.args)) ??
                (await freeServicePort()),
              "--strict-gateway-port",
            ]
          : requestedArgs;
      const portNote = pinsPort
        ? [
            "This is not the default data directory, so its gateway keeps a free port chosen at install instead of the fixed one.",
          ]
        : secondBackend && !requestedArgs.includes("--port")
          ? [
              "This is not the default data directory, so its gateway takes a free port that changes on each start. For a stable address, reinstall with `-- --port PORT`.",
            ]
          : [];
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
            ...portNote,
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
      const rollbackTarget = service.nextRollbackTarget(
        layout,
        service.readServiceConfig(layout),
        service.linkedVersion(layout.current),
        version,
      );
      await service.activateRelease(layout, version);
      const installGeneration = randomUUID();
      await service.writeServiceConfig(layout, {
        installGeneration,
        version: 1,
        dataDir,
        bun,
        bunVersion,
        args: serveArgs,
        ...(rollbackTarget ? { rollbackTarget } : {}),
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
        // The generation excludes failures written by the old launcher while
        // manager commands run; the timestamp also excludes earlier logs.
        const loadedAt = Date.now();
        const logOffset = await stat(logFile).then(
          (file) => file.size,
          () => 0,
        );
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
            expectedVersion: version,
            assertStarting: async () => {
              const failure = service.readStartupFailure(
                layout,
                version,
                loadedAt,
                installGeneration,
              );
              if (failure) throw await startupFailedError(version, failure, logFile, logOffset);
            },
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
          clientUrls: connection?.clientUrls ?? [],
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
                  ...(connection.clientUrls.length > 0
                    ? [["local listeners", connection.clientUrls.join(", ")] as [string, string]]
                    : []),
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
          ...portNote,
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
      const current = service.linkedVersion(layout.current);
      const previous = service.linkedVersion(layout.previous);
      const result = {
        dataDir,
        installed,
        running,
        unit: { manager: unit.manager, name: unit.name, file: unit.file },
        current,
        previous,
        bun: config?.bun ?? null,
        args: service.effectiveServiceArguments(config, current, previous),
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
