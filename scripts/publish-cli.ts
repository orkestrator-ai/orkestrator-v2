#!/usr/bin/env bun
/**
 * Publish the `orkestrator` npm package under its update channel's dist-tag.
 *
 *   bun scripts/publish-cli.ts [--ci]
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
 * `--ci` is the path `release:publish` uses: the "Publish npm package"
 * workflow (`.github/workflows/publish-npm.yml`) runs it on a GitHub-hosted
 * runner. It packs the package once (prepack builds it, with the build commit),
 * smoke-tests that exact tarball and publishes it with `npm publish
 * --provenance`, authenticated by npm trusted publishing (the job's OIDC
 * token), so no npm credential exists anywhere. It refuses to run anywhere
 * else. The rest of this comment describes the local path, kept as the
 * fallback (`release:publish --npm-local`) until CI publishing has shipped a
 * release.
 *
 * Authentication of the local path (docs/development/releasing.md, "npm authentication"):
 *
 * - With an npm token exported as `NPM_CONFIG_TOKEN` (or `BUN_CONFIG_TOKEN`),
 *   `bun publish` uses it. No token is kept on this machine, so that is a
 *   deliberate one-off.
 * - Otherwise npm asks for web sign-in and prints a link that expires after
 *   about five minutes. The link raises a desktop notification
 *   (`release-approval.ts`), and an attempt whose link expired unapproved is
 *   retried with a fresh link, up to `ORKESTRATOR_NPM_AUTH_ATTEMPTS` (3).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

export type NpmTokenSource = { kind: "environment"; variable: string } | { kind: "none" };

/**
 * Where this publish's npm credential comes from: a token exported for this
 * run, or none, in which case npm asks for a browser sign-in. A token is never
 * read from a file: the release no longer keeps a long-lived publish
 * credential on a workstation (the package is published from GitHub).
 */
export function resolveNpmToken(env: NodeJS.ProcessEnv): NpmTokenSource {
  for (const variable of ["NPM_CONFIG_TOKEN", "BUN_CONFIG_TOKEN"]) {
    if (env[variable]?.trim()) return { kind: "environment", variable };
  }
  return { kind: "none" };
}

/** `bun publish` gave up because nobody approved the web sign-in in time. */
export function npmWebAuthExpired(output: string): boolean {
  return /404[^\n]*\/-\/v1\/done/.test(output);
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
  log?: (line: string) => void;
};

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
  const token = resolveNpmToken(env);
  const childEnv = buildCommitEnv(repositoryRoot, env);
  if (token.kind === "environment") {
    log(`Publishing with the npm token in ${token.variable}.`);
  } else {
    log("No npm token, so npm will ask for browser approval; a notification will say when.");
  }

  const attempts = npmAuthAttempts(env);
  for (let attempt = 1; ; attempt++) {
    log(`\n$ ${command.join(" ")}`);
    let tail = "";
    const watcher = new ApprovalWatcher(onApproval);
    const result = await run(command, {
      cwd: repositoryRoot,
      env: childEnv,
      onOutput: (text) => {
        tail = (tail + text).slice(-OUTPUT_TAIL_BYTES);
        watcher.push(text);
      },
    });
    const exitCode = result.exitCode ?? 1;
    const sawSignIn = watcher.links().some((link) => link.kind === "npm");
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

/** npm 11.5.1 is the first release that can authenticate a publish with trusted publishing. */
export const TRUSTED_PUBLISHING_MIN_NPM = [11, 5, 1] as const;

export function npmSupportsTrustedPublishing(version: string): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())?.slice(1).map(Number);
  if (!parts) return false;
  for (let index = 0; index < 3; index++) {
    const have = parts[index] ?? 0;
    const need = TRUSTED_PUBLISHING_MIN_NPM[index] ?? 0;
    if (have !== need) return have > need;
  }
  return true;
}

/** Packs the CLI into `destination`. `prepack` rebuilds it, so the build commit must be in the environment. */
export function cliPackCommand(destination: string): string[] {
  return ["bun", "pm", "pack", "--cwd", "packages/cli", "--destination", destination];
}

export function cliSmokeCommand(tarball: string): string[] {
  return ["bun", "packages/cli/scripts/smoke-packed.ts", "--tarball", tarball];
}

/**
 * Publishes the tarball that was packed and smoke-tested. `--provenance` makes
 * a publish that cannot attest where it came from fail instead of going out
 * unsigned.
 */
export function cliNpmPublishCommand(version: string, tarball: string): string[] {
  const channel = hostUpdateChannelOfVersion(version);
  if (!channel) {
    throw new Error(
      `${version} has a suffix no update channel ships. Use no suffix (Stable), -beta or -alpha (Unstable).`,
    );
  }
  return [
    "npm",
    "publish",
    tarball,
    "--access",
    "public",
    "--tag",
    HOST_UPDATE_CHANNEL_TAGS[channel],
    "--provenance",
  ];
}

/** Variables npm would use instead of the job's OIDC identity. */
const NPM_CREDENTIAL_VARIABLES = [
  "NPM_CONFIG_TOKEN",
  "BUN_CONFIG_TOKEN",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
] as const;

export type CiPublishOptions = {
  repositoryRoot?: string;
  run?: PublishRunner;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** Where the tarball is packed; a fresh temporary directory by default. */
  workDirectory?: string;
  npmVersion?: () => string;
};

function installedNpmVersion(): string {
  const result = Bun.spawnSync(["npm", "--version"], { stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : "";
}

/**
 * Packs, smoke-tests and publishes the CLI from a GitHub Actions job. Returns
 * the exit status of the first step that fails, with nothing published unless
 * the last one ran.
 */
export async function publishCliFromCi(options: CiPublishOptions = {}): Promise<number> {
  const repositoryRoot = options.repositoryRoot ?? root;
  const run = options.run ?? spawnPublish;
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));

  if (env.GITHUB_ACTIONS !== "true" || !env.ACTIONS_ID_TOKEN_REQUEST_URL) {
    throw new Error(
      "--ci publishes through npm trusted publishing and only runs in the Publish npm package " +
        "workflow, with `id-token: write`. Locally, use `mise run publish:cli`.",
    );
  }
  const npmVersion = (options.npmVersion ?? installedNpmVersion)();
  if (!npmSupportsTrustedPublishing(npmVersion)) {
    throw new Error(
      `npm ${npmVersion || "(not found)"} cannot publish with trusted publishing; it needs ${TRUSTED_PUBLISHING_MIN_NPM.join(".")} or newer.`,
    );
  }

  const { version } = JSON.parse(
    readFileSync(path.join(repositoryRoot, "packages/cli/package.json"), "utf8"),
  ) as { version: string };

  // Trusted publishing is only used when no other credential is present.
  const childEnv = buildCommitEnv(repositoryRoot, env);
  for (const variable of NPM_CREDENTIAL_VARIABLES) delete childEnv[variable];
  if (!childEnv.ORKESTRATOR_BUILD_COMMIT) {
    throw new Error(
      "No commit describes this checkout exactly (modified or untracked files, or no repository), so the build commit cannot be embedded.",
    );
  }

  const ownsWorkDirectory = options.workDirectory === undefined;
  const workDirectory =
    options.workDirectory ?? mkdtempSync(path.join(tmpdir(), "orkestrator-npm-"));
  const tarball = path.join(workDirectory, `orkestrator-${version}.tgz`);
  try {
    const steps = [
      cliPackCommand(workDirectory),
      cliSmokeCommand(tarball),
      cliNpmPublishCommand(version, tarball),
    ];
    for (const [index, command] of steps.entries()) {
      log(`\n$ ${command.join(" ")}`);
      const result = await run(command, {
        cwd: repositoryRoot,
        env: childEnv,
        onOutput: () => undefined,
      });
      const exitCode = result.exitCode ?? 1;
      if (exitCode !== 0) return exitCode;
      if (index === 0 && !existsSync(tarball)) {
        throw new Error(`Packing did not produce ${tarball}.`);
      }
    }
    return 0;
  } finally {
    if (ownsWorkDirectory) rmSync(workDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--ci") {
      process.exitCode = await publishCliFromCi();
    } else if (args.length === 0) {
      process.exitCode = await publishCli();
    } else {
      throw new Error("usage: publish-cli.ts [--ci]");
    }
  } catch (error) {
    console.error(`publish-cli: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
