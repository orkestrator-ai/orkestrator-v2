#!/usr/bin/env bun
/**
 * Run the Linux half of a desktop release on the Linux builder, from the Mac.
 *
 *   bun scripts/release-linux-remote.ts check            # can we reach and use the builder?
 *   bun scripts/release-linux-remote.ts build [--no-publish]
 *   bun scripts/release-linux-remote.ts attach           # follow a build already running
 *
 * Options: `--host <ssh-host>` (default `ORKESTRATOR_RELEASE_LINUX_HOST`, else
 * `omarchy-hp`) and `--checkout <dir>` (default
 * `ORKESTRATOR_RELEASE_LINUX_CHECKOUT`, else `~/project/apps/orkestrator-v2`).
 *
 * `build` checks out this checkout's HEAD on the builder and starts
 * `release-desktop.ts build` there under `nohup`, so a dropped SSH connection
 * does not stop it; `attach` follows its log again. The builder's Git talks
 * to GitHub over HTTPS through its signed-in `gh`, because an SSH session from
 * here carries no GitHub key. That setting lives only in the build's
 * environment; the builder's Git config is not changed.
 *
 * A Tailscale SSH check printed while connecting raises a desktop notification
 * (`release-approval.ts`), as npm's sign-in link does.
 *
 * The full procedure is in docs/development/releasing.md ("Linux build from the Mac").
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { hostUpdateChannelOfVersion } from "../packages/protocol/src/host-maintenance.js";
import {
  alertApproval,
  ApprovalWatcher,
  teeStream,
  type ApprovalLink,
} from "./release-approval.js";

const root = path.resolve(import.meta.dir, "..");

export const DEFAULT_LINUX_BUILDER_HOST = "omarchy-hp";
export const DEFAULT_LINUX_BUILDER_CHECKOUT = "~/project/apps/orkestrator-v2";

export type RemoteMode = "check" | "build" | "attach";

export type RemoteReleaseOptions = {
  mode: RemoteMode;
  host: string;
  checkout: string;
  publish: boolean;
};

const USAGE =
  "usage: release-linux-remote.ts check | build [--no-publish] | attach  [--host <ssh-host>] [--checkout <dir>]";

export function parseRemoteReleaseArgs(
  args: string[],
  env: NodeJS.ProcessEnv,
): RemoteReleaseOptions {
  const [mode, ...rest] = args;
  if (mode !== "check" && mode !== "build" && mode !== "attach") throw new Error(USAGE);
  const options: RemoteReleaseOptions = {
    mode,
    host: env.ORKESTRATOR_RELEASE_LINUX_HOST || DEFAULT_LINUX_BUILDER_HOST,
    checkout: env.ORKESTRATOR_RELEASE_LINUX_CHECKOUT || DEFAULT_LINUX_BUILDER_CHECKOUT,
    publish: true,
  };
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === "--no-publish" && mode === "build") {
      options.publish = false;
    } else if ((flag === "--host" || flag === "--checkout") && rest[index + 1]) {
      options[flag === "--host" ? "host" : "checkout"] = rest[++index]!;
    } else {
      throw new Error(USAGE);
    }
  }
  // An option-looking host would be read by ssh as one of its own flags.
  if (options.host.startsWith("-") || /\s/.test(options.host)) {
    throw new Error(`invalid SSH host: ${options.host}`);
  }
  return options;
}

/** Quotes one word for a POSIX shell. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The script the builder runs with `bash -s`, taking its inputs as positional
 * arguments: mode, checkout, commit, version, and `release-desktop.ts build`'s
 * flags.
 */
export const REMOTE_SCRIPT_PATH = path.join(import.meta.dir, "release-linux-remote.sh");

export function sshCommand(host: string, remoteArgs: string[]): string[] {
  return [
    "ssh",
    "-o",
    "ConnectTimeout=20",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=6",
    host,
    ["bash", "-s", "--", ...remoteArgs.map(shellQuote)].join(" "),
  ];
}

export function remoteArgs(
  options: RemoteReleaseOptions,
  commit: string,
  version: string,
): string[] {
  const flags = options.mode === "build" && !options.publish ? ["--no-publish"] : [];
  return [options.mode, options.checkout, commit, version, ...flags];
}

export type RemoteRuntime = {
  version: () => string;
  head: () => string;
  /** Runs `command` with `script` on stdin, passing output through; returns its exit code. */
  run: (command: string[], script: string, onOutput: (text: string) => void) => Promise<number>;
  onApproval: (link: ApprovalLink) => void;
  log: (line: string) => void;
};

function capture(command: string[]): string {
  const result = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`\`${command.join(" ")}\` failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

const defaultRuntime: RemoteRuntime = {
  version: () =>
    (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string })
      .version,
  head: () => capture(["git", "rev-parse", "HEAD"]),
  run: async (command, script, onOutput) => {
    const child = Bun.spawn(command, { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(script);
    await child.stdin.end();
    await Promise.all([
      teeStream(child.stdout, process.stdout, onOutput),
      teeStream(child.stderr, process.stderr, onOutput),
    ]);
    return await child.exited;
  },
  onApproval: (link) => alertApproval(link),
  log: (line) => console.log(line),
};

export async function runRemoteRelease(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  runtime: RemoteRuntime = defaultRuntime,
): Promise<number> {
  const options = parseRemoteReleaseArgs(args, env);
  const version = runtime.version();
  if (!hostUpdateChannelOfVersion(version)) {
    throw new Error(`${version} has a suffix no update channel ships.`);
  }
  const commit = runtime.head();
  const command = sshCommand(options.host, remoteArgs(options, commit, version));
  runtime.log(
    `\n${options.mode === "check" ? "Checking" : options.mode === "build" ? "Building" : "Following"} the Linux release of v${version} on ${options.host}` +
      (options.mode === "build" ? ` at ${commit.slice(0, 8)}` : "") +
      ".",
  );
  runtime.log(`$ ${command.slice(0, -1).join(" ")} 'bash -s -- …'`);
  const watcher = new ApprovalWatcher(runtime.onApproval);
  const script = readFileSync(REMOTE_SCRIPT_PATH, "utf8");
  // The tail is enough to spot the start marker even when it straddles chunks.
  let tail = "";
  let started = false;
  const exitCode = await runtime.run(command, script, (text) => {
    watcher.push(text);
    tail = (tail + text).slice(-MARKER_CARRY_BYTES);
    if (tail.includes(BUILD_STARTED_MARKER)) started = true;
  });
  for (const line of remoteReleaseAdvice(options, exitCode, started)) runtime.log(line);
  return exitCode;
}

/** What the builder prints once the detached build is running. */
export const BUILD_STARTED_MARKER = "started the Linux release build";
const MARKER_CARRY_BYTES = 4096;
const ATTACH = "`mise run release:linux -- attach`";

/**
 * What to tell the operator after the remote command ended. ssh exits 255
 * both when it cannot connect and when an established session dies, so 255
 * alone does not say whether a build is running; the start marker does.
 */
export function remoteReleaseAdvice(
  options: Pick<RemoteReleaseOptions, "mode" | "host">,
  exitCode: number,
  started: boolean,
): string[] {
  if (exitCode === 0) return [];
  const following = started || options.mode === "attach";
  if (exitCode === 255) {
    if (following) {
      return [
        `\nThe ssh connection to ${options.host} dropped (exit 255). The build carries on there; follow it again with ${ATTACH}.`,
      ];
    }
    const lines = [
      `\nssh could not reach ${options.host}, or lost the connection (exit 255). Check \`ssh ${options.host} true\`, Tailscale, and ORKESTRATOR_RELEASE_LINUX_HOST.`,
    ];
    if (options.mode === "build") {
      lines.push(`If the build had already started it carries on; ${ATTACH} shows it.`);
    }
    return lines;
  }
  if (options.mode === "build" && !started) {
    return [
      `\nThe builder did not start the build (exit ${exitCode}); see its message above. Nothing is running there.`,
    ];
  }
  if (following) {
    return [`\n${ATTACH} replays the build's log and result.`];
  }
  return [];
}

if (import.meta.main) {
  try {
    process.exitCode = await runRemoteRelease(process.argv.slice(2));
  } catch (error) {
    console.error(
      `release-linux-remote: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
