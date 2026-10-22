import { existsSync } from "node:fs";
import os from "node:os";
import { CliError } from "./errors.js";
import type { ClientIo } from "./io.js";

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

/** Shell-quotes one argument for the equivalent command line. */
function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * Asks the setup questions and returns the serve arguments, after the user
 * confirms the equivalent non-interactive command.
 */
export async function askServeArguments(
  io: ClientIo,
  options: { installCommand: string[]; probe?: SetupProbe },
): Promise<string[]> {
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
  if (access !== "ssh" && !probe.hasTailscaleAddress()) {
    io.stderr(
      "\nThis machine has no Tailscale address yet. Connect Tailscale before the service starts, or it will not serve.\n",
    );
  }
  if (access === "serve") {
    args.push("--tailscale-serve");
    if (!probe.findTailscaleCli()) {
      io.stderr("\nThe Tailscale CLI was not found, and Tailscale Serve needs it.\n");
      const cli = await ask(io, "Path to the tailscale executable (empty to keep `tailscale`): ");
      if (cli !== "") args.push("--tailscale-bin", cli);
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
