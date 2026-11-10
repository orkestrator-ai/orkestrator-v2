#!/usr/bin/env bun
/**
 * Publish the `orkestrator` npm package under its update channel's dist-tag.
 *
 *   bun scripts/publish-cli.ts
 *
 * The tag comes from the package version's suffix, as for the desktop
 * release: `2.23.0` publishes as `latest`, `2.23.0-beta` as `beta` and
 * `2.23.0-alpha` as `alpha`. `bun publish` would otherwise tag every version
 * `latest`, handing a prerelease to every `bunx orkestrator` user and every
 * Stable standalone backend.
 *
 * `bun publish` rebuilds the package in its `prepack` step, without Turbo, so
 * this is where the published backend gets its build commit.
 *
 * Authentication (docs/development/releasing.md, "npm authentication"):
 *
 * - With a stored npm token (`NPM_CONFIG_TOKEN`, or the owner-only file
 *   `npmTokenFile` names), `bun publish` uses it. A granular token allowed to
 *   bypass two-factor authentication publishes with no browser step. When
 *   npm rejects the token from the file (expired, revoked, or not allowed to
 *   publish this package), the publish is tried once more without it, which
 *   is the browser approval below.
 * - Otherwise npm asks for web sign-in and prints a link that expires after
 *   about five minutes. The link raises a desktop notification
 *   (`release-approval.ts`), and an attempt whose link expired unapproved is
 *   retried with a fresh link, up to `ORKESTRATOR_NPM_AUTH_ATTEMPTS` (3).
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { buildCommitEnv } from "../packages/protocol/src/node/build-commit.js";
import {
  HOST_UPDATE_CHANNEL_TAGS,
  hostUpdateChannelOfVersion,
} from "../packages/protocol/src/host-maintenance.js";
import {
  alertApproval,
  ApprovalWatcher,
  teeStream,
  type ApprovalLink,
} from "./release-approval.js";

const root = path.resolve(import.meta.dir, "..");

export function cliPublishCommand(version: string): string[] {
  const channel = hostUpdateChannelOfVersion(version);
  if (!channel) {
    throw new Error(
      `${version} has a suffix no update channel ships. Use no suffix (Stable), -beta or -alpha (Unstable).`,
    );
  }
  return [
    "bun",
    "publish",
    "--cwd",
    "packages/cli",
    "--access",
    "public",
    "--tag",
    HOST_UPDATE_CHANNEL_TAGS[channel],
  ];
}

/** Where a maintainer keeps the npm publish token, unless `ORKESTRATOR_NPM_TOKEN_FILE` says otherwise. */
export function npmTokenFile(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  if (env.ORKESTRATOR_NPM_TOKEN_FILE) return env.ORKESTRATOR_NPM_TOKEN_FILE;
  const config = env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(config, "orkestrator-release", "npm-token");
}

export type NpmTokenSource =
  | { kind: "environment"; variable: string }
  | { kind: "file"; path: string; token: string }
  | { kind: "none"; path: string };

/**
 * Where this publish's npm credential comes from. An exported token wins, so
 * a CI job or a one-off run can override the file. The file must be readable
 * by its owner only: it is a long-lived publish credential.
 */
export function resolveNpmToken(
  env: NodeJS.ProcessEnv,
  fs: {
    mode: (file: string) => number | null;
    read: (file: string) => string;
  } = defaultTokenFs,
): NpmTokenSource {
  for (const variable of ["NPM_CONFIG_TOKEN", "BUN_CONFIG_TOKEN"]) {
    if (env[variable]?.trim()) return { kind: "environment", variable };
  }
  const file = npmTokenFile(env);
  const mode = fs.mode(file);
  if (mode === null) return { kind: "none", path: file };
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `${file} can be read by other users. Run \`chmod 600 ${file}\` before publishing with it.`,
    );
  }
  const token = fs.read(file).trim();
  if (!token || /\s/.test(token)) {
    throw new Error(`${file} must hold exactly one npm token and nothing else.`);
  }
  return { kind: "file", path: file, token };
}

const defaultTokenFs = {
  mode: (file: string): number | null => {
    try {
      return statSync(file).mode;
    } catch {
      return null;
    }
  },
  read: (file: string) => readFileSync(file, "utf8"),
};

/** `bun publish` gave up because nobody approved the web sign-in in time. */
export function npmWebAuthExpired(output: string): boolean {
  return /404[^\n]*\/-\/v1\/done/.test(output);
}

/**
 * npm refused the credential itself, as opposed to the publish: a 401, or a
 * 403 that names the token, two-factor authentication or a missing
 * permission. Republishing an existing version is also a 403 but is not a
 * credential problem, and a browser sign-in would not fix it.
 */
export function npmTokenRejected(output: string): boolean {
  if (/cannot publish over|previously published/i.test(output)) return false;
  return (
    /\b(?:E?401)\b|unauthorized/i.test(output) ||
    /\b(?:E?403)\b[^\n]*(?:token|two-factor|2fa|one-time password|otp|with these credentials|do not have permission)/i.test(
      output,
    )
  );
}

export function npmAuthAttempts(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.ORKESTRATOR_NPM_AUTH_ATTEMPTS);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 10 ? parsed : 3;
}

export type PublishRunner = (
  command: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; onOutput: (text: string) => void },
) => Promise<{ exitCode: number | null }>;

type OutputSink = { write: (chunk: Uint8Array) => unknown };

/**
 * A runner that passes the command's output through to `sinks` (this
 * terminal, by default) and to `onOutput`. Tests hand it their own sinks.
 */
export function createPublishRunner(
  sinks: { stdout: OutputSink; stderr: OutputSink } = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): PublishRunner {
  return async (command, { cwd, env, onOutput }) => {
    const child = Bun.spawn(command, {
      cwd,
      env,
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    });
    await Promise.all([
      teeStream(child.stdout, sinks.stdout, onOutput),
      teeStream(child.stderr, sinks.stderr, onOutput),
    ]);
    return { exitCode: await child.exited };
  };
}

/** Runs the command with its output passed through to this terminal and to `onOutput`. */
export const spawnPublish: PublishRunner = createPublishRunner();

/** The last output kept per attempt, enough for npm's closing error. */
const OUTPUT_TAIL_BYTES = 64 * 1024;

export type PublishOptions = {
  repositoryRoot?: string;
  run?: PublishRunner;
  env?: NodeJS.ProcessEnv;
  onApproval?: (link: ApprovalLink) => void;
  tokenFs?: Parameters<typeof resolveNpmToken>[1];
  log?: (line: string) => void;
};

function withoutToken(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.NPM_CONFIG_TOKEN;
  return next;
}

/** The runner is injectable so tests can exercise prepack without publishing. */
export async function publishCli(options: PublishOptions = {}): Promise<number> {
  const repositoryRoot = options.repositoryRoot ?? root;
  const run = options.run ?? spawnPublish;
  const env = options.env ?? process.env;
  const onApproval = options.onApproval ?? ((link: ApprovalLink) => alertApproval(link));
  const log = options.log ?? ((line: string) => console.log(line));

  const { version } = JSON.parse(
    readFileSync(path.join(repositoryRoot, "packages/cli/package.json"), "utf8"),
  ) as { version: string };
  const command = cliPublishCommand(version);
  const token = resolveNpmToken(env, options.tokenFs);
  const childEnv = buildCommitEnv(repositoryRoot, env);
  if (token.kind === "file") {
    childEnv.NPM_CONFIG_TOKEN = token.token;
    log(`Publishing with the npm token in ${token.path}.`);
  } else if (token.kind === "environment") {
    log(`Publishing with the npm token in ${token.variable}.`);
  } else {
    log(
      `No npm token (${token.path} is absent), so npm will ask for browser approval; a notification will say when.`,
    );
  }

  const attempts = npmAuthAttempts(env);
  const storedTokenPath = token.kind === "file" ? token.path : null;
  let usingStoredToken = storedTokenPath !== null;
  for (let attempt = 1; ; attempt++) {
    log(`\n$ ${command.join(" ")}`);
    let tail = "";
    const watcher = new ApprovalWatcher(onApproval);
    const result = await run(command, {
      cwd: repositoryRoot,
      env: storedTokenPath !== null && !usingStoredToken ? withoutToken(childEnv) : childEnv,
      onOutput: (text) => {
        tail = (tail + text).slice(-OUTPUT_TAIL_BYTES);
        watcher.push(text);
      },
    });
    const exitCode = result.exitCode ?? 1;
    const sawSignIn = watcher.links().some((link) => link.kind === "npm");
    if (exitCode !== 0 && usingStoredToken && !sawSignIn && npmTokenRejected(tail)) {
      // Nothing was published with a rejected credential, so asking again cannot publish twice.
      usingStoredToken = false;
      attempt--;
      log(
        `npm rejected the token in ${storedTokenPath} (expired, revoked, or not allowed to publish orkestrator). ` +
          "Renew it; publishing with browser approval instead, and a notification will say when.",
      );
      continue;
    }
    const expired = exitCode !== 0 && sawSignIn && npmWebAuthExpired(tail);
    if (!expired) return exitCode;
    if (attempt >= attempts) {
      log(`npm sign-in expired unapproved ${attempt} times; nothing was published.`);
      return exitCode;
    }
    // An expired sign-in publishes nothing, so asking again cannot publish twice.
    log(
      `npm sign-in expired before approval; asking again (attempt ${attempt + 1} of ${attempts}).`,
    );
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await publishCli();
  } catch (error) {
    console.error(`publish-cli: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
