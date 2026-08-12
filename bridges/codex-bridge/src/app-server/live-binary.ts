/**
 * Resolves the `codex` binary the live app-server contract tests run against,
 * and asserts it is the version pinned in `config/codex-version.json`.
 *
 * This lives in a non-test module for two reasons. The contract tests it serves
 * are gated behind `RUN_LIVE_CODEX_APP_SERVER=1`, so anything defined inside
 * them is never exercised by the default suite — including the failure paths,
 * which are exactly the ones a developer meets first. And the resolution order
 * has to stay in step with `scripts/generate-codex-app-server-protocol.ts`:
 * the generator and these tests must agree on which binary "the pinned binary"
 * means, or the runtime contract is checked against a different build than the
 * one the committed bindings were generated from.
 *
 * Every seam that touches the machine (spawning the probe, testing for a file,
 * reading the pin, reading the environment) is injectable so the resolver can
 * be unit-tested without a real Codex install.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Path shown in errors; the file is the single source of truth for the pin. */
export const VERSION_CONFIG_RELATIVE_PATH = "config/codex-version.json";

/**
 * Mirrors the generator's `execFile(..., { timeout: 30_000 })`. Without it a
 * wedged binary would burn the whole per-test budget before failing.
 */
export const DEFAULT_VERSION_PROBE_TIMEOUT_MS = 30_000;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

interface VersionConfig {
  version: string;
}

/** Reads the pinned Codex version from `config/codex-version.json`. */
export async function pinnedVersion(): Promise<string> {
  const config = JSON.parse(
    await readFile(join(repoRoot, "config", "codex-version.json"), "utf8"),
  ) as VersionConfig;
  return config.version;
}

export interface SelectBinaryOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  architecture?: string;
  homeDirectory?: string;
  xdgConfigHome?: string;
  /** Injected in tests so no real toolchain has to exist. */
  existsImpl?: (path: string) => boolean;
}

/** Where the desktop app installs its managed copy of a pinned Codex version. */
export function managedBinaryPath(
  version: string,
  options: SelectBinaryOptions = {},
): string {
  const env = options.env ?? process.env;
  const currentPlatform = options.platform ?? platform();
  const currentArchitecture = options.architecture ?? process.arch;
  const homeDirectory = options.homeDirectory ?? homedir();
  const arch = currentArchitecture === "arm64" ? "arm64" : "x64";
  const root =
    currentPlatform === "darwin"
      ? join(homeDirectory, "Library", "Application Support", "orkestrator-v2", "toolchains")
      : join(
          options.xdgConfigHome ?? env.XDG_CONFIG_HOME ?? join(homeDirectory, ".config"),
          "orkestrator-v2",
          "toolchains",
        );
  return join(
    root,
    "codex",
    version,
    `${currentPlatform === "darwin" ? "darwin" : "linux"}-${arch}`,
    "codex",
  );
}

/**
 * Picks a candidate binary using the same precedence as
 * `candidateBinaries()` in `scripts/generate-codex-app-server-protocol.ts`:
 * explicit override, then the managed toolchain copy of the pinned version,
 * then `CODEX_PATH`, then whatever `codex` is on PATH.
 *
 * `CODEX_PATH` is what `process-supervisor.ts` actually launches (see
 * `docs/upgrade-agents.md`), so omitting it here would fail the suite for a
 * developer whose pinned binary is exactly where the supervisor expects it.
 *
 * `CODEX_PROTOCOL_BINARY` stays a hard assertion rather than a hint: during an
 * upgrade, silently falling through to auto-discovery would test the *old*
 * managed binary against the new pin and report which of the two is wrong.
 */
export function selectCodexBinary(
  version: string,
  options: SelectBinaryOptions = {},
): string {
  const env = options.env ?? process.env;
  const exists = options.existsImpl ?? existsSync;

  const override = env.CODEX_PROTOCOL_BINARY?.trim();
  if (override) {
    if (override.includes(sep) && !exists(override)) {
      throw new Error(`CODEX_PROTOCOL_BINARY does not exist: ${override}`);
    }
    return override;
  }

  const managed = managedBinaryPath(version, options);
  if (exists(managed)) return managed;

  // A bare name is left for PATH lookup to resolve; only a path-like value can
  // be existence-checked, and skipping a missing one falls through to `codex`.
  const configured = env.CODEX_PATH?.trim();
  if (configured && (!configured.includes(sep) || exists(configured))) return configured;

  return "codex";
}

const SEMVER_PATTERN = /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/;

/**
 * Extracts the version from `codex --version` output (`codex-cli 0.147.0`).
 *
 * Deliberately scoped to the first non-empty line: taking the last whitespace
 * token of the whole output — which is what the generator does — would silently
 * pick up an appended update notice ("A new version 9.9.9 is available") and
 * report a mismatch against a string the binary never claimed as its version.
 */
export function parseReportedVersion(stdout: string): string | null {
  const firstLine = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!firstLine) return null;
  return SEMVER_PATTERN.exec(firstLine)?.[0] ?? null;
}

export interface VersionProbeResult {
  stdout: string;
  stderr: string;
  /** `null` when the child was killed by a signal. */
  exitCode: number | null;
}

export type VersionProbe = (
  binary: string,
  timeoutMs: number,
) => Promise<VersionProbeResult>;

/**
 * Runs `<binary> --version`, killing it if it hangs.
 *
 * Note that a missing binary makes `Bun.spawn` **throw** ("Executable not found
 * in $PATH") rather than return a non-zero exit code, so callers must handle
 * both. That is the most likely failure of all and the reason the caller wraps
 * this in pin context.
 */
export async function spawnVersionProbe(
  binary: string,
  timeoutMs: number,
): Promise<VersionProbeResult> {
  const child = Bun.spawn([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (timedOut) {
      throw new Error(`\`${binary} --version\` did not respond within ${timeoutMs}ms`);
    }
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
}

export interface ResolveBinaryOptions extends SelectBinaryOptions {
  probeImpl?: VersionProbe;
  readPinnedVersionImpl?: () => Promise<string>;
  timeoutMs?: number;
}

function describeUnusableBinary(binary: string, version: string, detail: string): string {
  return (
    `Could not execute ${binary}: ${detail}. `
    + `${VERSION_CONFIG_RELATIVE_PATH} pins codex ${version}; set CODEX_PROTOCOL_BINARY `
    + "or CODEX_PATH to that binary, or install the pinned toolchain."
  );
}

/**
 * Resolves the pinned binary, failing loudly when it is missing, unrunnable or
 * a different version. Not memoised — see {@link resolveCodexBinary}.
 */
export async function resolveCodexBinaryUncached(
  options: ResolveBinaryOptions = {},
): Promise<string> {
  const version = await (options.readPinnedVersionImpl ?? pinnedVersion)();
  const binary = selectCodexBinary(version, options);
  const probe = options.probeImpl ?? spawnVersionProbe;

  let result: VersionProbeResult;
  try {
    result = await probe(binary, options.timeoutMs ?? DEFAULT_VERSION_PROBE_TIMEOUT_MS);
  } catch (error) {
    // Bun's own "Executable not found in $PATH" carries none of the pin
    // context, which is the only thing that makes this failure actionable.
    throw new Error(
      describeUnusableBinary(
        binary,
        version,
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      describeUnusableBinary(
        binary,
        version,
        result.stderr.trim() || `exited with ${result.exitCode ?? "a signal"}`,
      ),
    );
  }

  const reportedVersion = parseReportedVersion(result.stdout);
  if (reportedVersion !== version) {
    throw new Error(
      `${binary} reports ${reportedVersion || "an unknown version"}, but `
      + `${VERSION_CONFIG_RELATIVE_PATH} pins ${version}`,
    );
  }
  return binary;
}

let resolved: Promise<string> | undefined;

/**
 * Memoised {@link resolveCodexBinaryUncached}.
 *
 * Every live test boots its own app-server, so an unmemoised resolver re-reads
 * the pin and spawns `codex --version` once per test. The *promise* is cached
 * rather than the value so concurrent callers share a single probe, and a
 * failure stays cached: a wrong or missing binary is not going to fix itself
 * eleven tests later.
 *
 * Options are only honoured on the first call; use
 * {@link resetResolvedCodexBinary} between tests.
 */
export function resolveCodexBinary(options: ResolveBinaryOptions = {}): Promise<string> {
  resolved ??= resolveCodexBinaryUncached(options);
  return resolved;
}

/** Clears the memo. Test-only. */
export function resetResolvedCodexBinary(): void {
  resolved = undefined;
}
