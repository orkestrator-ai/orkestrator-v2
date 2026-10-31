import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import {
  DEFAULT_CONTROL_MCP_PORT,
  DEFAULT_GATEWAY_PORT,
} from "../../../../apps/backend/src/fixed-ports.js";
import { CliError } from "./errors.js";
import type { ClientIo } from "./io.js";
import { throwIfInterrupted } from "./wait.js";

/**
 * The interactive half of `service install`: asks how clients will reach the
 * backend and turns the answers into the same serve arguments a scripted
 * install passes after `--`. It only runs when nothing was passed there, so
 * every answer has a flag equivalent and the summary prints it.
 */

export const HOSTED_WEB_ORIGINS = "https://orkestrator.dev,https://www.orkestrator.dev";
/** The loopback port the desktop's **Add over SSH** form suggests. */
export const SSH_LOOPBACK_PORT = "34125";
const MACOS_TAILSCALE_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

type Access = "serve" | "tailnet" | "ssh";

export interface SetupProbe {
  /** Whether any interface holds a Tailscale (100.64.0.0/10) address. */
  hasTailscaleAddress(): boolean;
  /** The Tailscale CLI the backend would find by default, or null. */
  findTailscaleCli(): string | null;
  /**
   * The user to make Tailscale's operator when this one may not configure
   * Serve, or null when it may or that cannot be told.
   */
  tailscaleOperatorNeeded(cli: string): string | null;
  /** Runs the operator command with sudo; whether it succeeded. */
  grantTailscaleOperator(cli: string, user: string): boolean;
}

export const systemSetupProbe: SetupProbe = {
  hasTailscaleAddress: () =>
    Object.values(os.networkInterfaces()).some((entries) =>
      (entries ?? []).some((entry) => entry.family === "IPv4" && isTailscaleIPv4(entry.address)),
    ),
  findTailscaleCli: () => {
    if (process.platform === "darwin" && existsSync(MACOS_TAILSCALE_APP_CLI)) {
      return MACOS_TAILSCALE_APP_CLI;
    }
    return typeof Bun === "undefined" ? null : Bun.which("tailscale");
  },
  tailscaleOperatorNeeded: (cli) => {
    // Linux tailscaled lets only root and its operator change Serve. A macOS
    // administrator already may.
    if (process.platform !== "linux") return null;
    const user = os.userInfo();
    if (user.uid === 0) return null;
    const prefs = spawnSync(cli, ["debug", "prefs"], { encoding: "utf8", timeout: 10_000 });
    if (prefs.status !== 0) return null;
    try {
      const { OperatorUser } = JSON.parse(prefs.stdout) as { OperatorUser?: unknown };
      return OperatorUser === user.username ? null : user.username;
    } catch {
      return null;
    }
  },
  grantTailscaleOperator: (cli, user) =>
    spawnSync("sudo", [cli, "set", `--operator=${user}`], { stdio: "inherit" }).status === 0,
};

function isTailscaleIPv4(address: string): boolean {
  const [first, second] = address.split(".").map(Number);
  return first === 100 && second !== undefined && second >= 64 && second <= 127;
}

function cancelled(): CliError {
  return new CliError("invalid-input", "Setup cancelled; nothing was installed");
}

async function ask(io: ClientIo, prompt: string): Promise<string> {
  const answer = await io.question!(prompt);
  if (answer === null) throw cancelled();
  return answer.trim();
}

async function choose(
  io: ClientIo,
  title: string,
  choices: Array<{ value: Access; label: string }>,
): Promise<Access> {
  io.stderr(`${title}\n`);
  choices.forEach((choice, index) => io.stderr(`  ${index + 1}) ${choice.label}\n`));
  for (;;) {
    const answer = await ask(io, `Choose 1-${choices.length} [1]: `);
    if (answer === "") return choices[0]!.value;
    const picked = choices[Number(answer) - 1];
    if (/^\d+$/.test(answer) && picked) return picked.value;
    io.stderr(`Enter a number from 1 to ${choices.length}.\n`);
  }
}

async function confirm(io: ClientIo, prompt: string, fallback: boolean): Promise<boolean> {
  for (;;) {
    const answer = (await ask(io, `${prompt} ${fallback ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
    if (answer === "") return fallback;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    io.stderr("Answer y or n.\n");
  }
}

/**
 * A remote client needs an address that survives a restart, and a backend of
 * another data directory takes a new free port on each start. Null keeps that.
 */
async function askGatewayPort(io: ClientIo): Promise<string | null> {
  io.stderr(
    `\nThis is not the default data directory, so ports ${DEFAULT_GATEWAY_PORT} and ${DEFAULT_CONTROL_MCP_PORT} stay with the main install. Without a port of its own, this backend takes a free one that changes on each start.\n`,
  );
  for (;;) {
    const answer = await ask(io, "Gateway port for a stable address (empty for a free one): ");
    if (answer === "") return null;
    const port = Number(answer);
    if (
      /^\d+$/.test(answer) &&
      port >= 1 &&
      port <= 65535 &&
      port !== DEFAULT_GATEWAY_PORT &&
      port !== DEFAULT_CONTROL_MCP_PORT
    ) {
      return answer;
    }
    io.stderr(
      `Enter a port from 1 to 65535, other than ${DEFAULT_GATEWAY_PORT} and ${DEFAULT_CONTROL_MCP_PORT}.\n`,
    );
  }
}

/** Shell-quotes one argument for the equivalent command line. */
function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

function operatorMessage(cli: string, user: string): string {
  return [
    `\nTailscale only lets root or its operator configure Serve, and ${user} is neither.`,
    "The backend cannot start with --tailscale-serve until this has been run once:",
    `  sudo ${quote(cli)} set --operator=${quote(user)}\n`,
  ].join("\n");
}

/** Scripted installs cannot be asked, so they only get told. */
export function warnIfTailscaleOperatorNeeded(
  io: ClientIo,
  serveArgs: readonly string[],
  probe: SetupProbe = systemSetupProbe,
): void {
  if (!serveArgs.includes("--tailscale-serve")) return;
  const binFlag = serveArgs.indexOf("--tailscale-bin");
  const cli =
    (binFlag >= 0 ? serveArgs[binFlag + 1] : undefined) ??
    io.env.ORKESTRATOR_TAILSCALE_BIN ??
    probe.findTailscaleCli();
  const user = cli ? probe.tailscaleOperatorNeeded(cli) : null;
  if (cli && user) io.stderr(operatorMessage(cli, user));
}

/**
 * Asks the setup questions and returns the serve arguments, after the user
 * confirms the equivalent non-interactive command.
 */
export async function askServeArguments(
  io: ClientIo,
  options: {
    installCommand: string[];
    probe?: SetupProbe;
    signal?: AbortSignal;
    /** Nothing may change: report a missing Tailscale operator, do not grant it. */
    dryRun?: boolean;
    /** The data directory is not the default one, so the fixed ports are not its own. */
    secondBackend?: boolean;
  },
): Promise<string[]> {
  const source = io;
  io = {
    ...source,
    question: async (prompt) => {
      throwIfInterrupted(options.signal);
      const answer = await source.question!(prompt, options.signal);
      throwIfInterrupted(options.signal);
      return answer;
    },
  };
  throwIfInterrupted(options.signal);
  const probe = options.probe ?? systemSetupProbe;
  io.stderr("Set up the Orkestrator backend service.\n\n");
  const access = await choose(io, "How will you connect to this machine?", [
    {
      value: "serve",
      label: "Tailscale with HTTPS (Tailscale Serve): the desktop app, the CLI and orkestrator.dev",
    },
    { value: "tailnet", label: "Tailscale address over HTTP: the desktop app and the CLI" },
    { value: "ssh", label: "SSH only: the desktop app through an SSH tunnel, no Tailscale" },
  ]);
  const args: string[] = [];
  if (access === "ssh") args.push("--host", "127.0.0.1", "--allow-non-tailscale-bind");
  if (access !== "ssh" && !probe.hasTailscaleAddress()) {
    io.stderr(
      "\nThis machine has no Tailscale address yet. Connect Tailscale before the service starts, or it will not serve.\n",
    );
  }
  if (access === "tailnet" && options.secondBackend) {
    const port = await askGatewayPort(io);
    if (port) args.push("--port", port);
  }
  if (access === "serve") {
    args.push("--tailscale-serve");
    let cli = probe.findTailscaleCli();
    if (!cli) {
      io.stderr("\nThe Tailscale CLI was not found, and Tailscale Serve needs it.\n");
      cli = await ask(io, "Path to the tailscale executable (empty to keep `tailscale`): ");
      if (cli !== "") args.push("--tailscale-bin", cli);
    }
    const operator = cli ? probe.tailscaleOperatorNeeded(cli) : null;
    if (cli && operator) {
      io.stderr(operatorMessage(cli, operator));
      const granted =
        !options.dryRun &&
        (await confirm(io, "Run it now with sudo?", true)) &&
        probe.grantTailscaleOperator(cli, operator);
      if (!granted && !options.dryRun) io.stderr("Continuing without it.\n");
    }
    if (await confirm(io, "\nAllow the hosted web client at orkestrator.dev?", true)) {
      args.push("--allowed-origins", HOSTED_WEB_ORIGINS);
    }
  }
  const ssh =
    access === "ssh" ||
    (await confirm(
      io,
      `\nAlso accept desktop connections over SSH (loopback port ${SSH_LOOPBACK_PORT})?`,
      false,
    ));
  if (ssh) args.push("--loopback-client-port", SSH_LOOPBACK_PORT);

  const command = [...options.installCommand, "--", ...args].map(quote).join(" ");
  io.stderr(`\nEquivalent command, for scripts:\n  ${command}\n\n`);
  if (!(await confirm(io, "Install with these settings?", true))) throw cancelled();
  return args;
}
