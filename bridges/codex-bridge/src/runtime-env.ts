/**
 * Refreshing the bridge's view of the managed container runtime environment.
 *
 * Tools installed *after* the bridge started (a fresh `bun`, `cargo`, `pyenv`)
 * and credentials rotated by the backend are only visible if their variables
 * are re-read before Codex runs. With `codex exec` this was enough, because every
 * turn spawned a new child that inherited the refreshed `process.env`.
 *
 * A persistent `codex app-server` child cannot see later changes to its parent's
 * environment: it snapshots at launch. So the app-server engine additionally
 * fingerprints these values and restarts the child when they change — see
 * `fingerprintRuntimeEnvironment`.
 */
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const RUNTIME_ENV_SCRIPT_ENV = "ORKESTRATOR_RUNTIME_ENV_SCRIPT";
export const DEFAULT_RUNTIME_ENV_SCRIPT = "/usr/local/bin/orkestrator-runtime-env.sh";

/**
 * Credential variables whose absence is authoritative. Unlike optional PATH
 * helpers, a missing managed credential means the backend cleared it and the
 * bridge must remove its stale inherited value before fingerprinting.
 */
export const RUNTIME_ENV_CREDENTIAL_VARIABLES: ReadonlySet<string> = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
]);

/**
 * The variables worth re-reading. Deliberately an allowlist: sourcing a user's
 * shell profile can emit anything, so only known runtime state and the managed
 * GitHub credential enter the bridge process.
 */
export const RUNTIME_ENV_VARIABLES: ReadonlySet<string> = new Set([
  "PATH",
  "BUN_INSTALL",
  "CARGO_HOME",
  "GOPATH",
  "PNPM_HOME",
  "DENO_INSTALL",
  "PYENV_ROOT",
  "RYE_HOME",
  "UV_TOOL_BIN_DIR",
  "VOLTA_HOME",
  "NVM_DIR",
  "FNM_DIR",
  "BASH_ENV",
  ...RUNTIME_ENV_CREDENTIAL_VARIABLES,
]);

export function getRuntimeEnvironmentScriptPath(): string {
  return process.env[RUNTIME_ENV_SCRIPT_ENV]?.trim() || DEFAULT_RUNTIME_ENV_SCRIPT;
}

export function applyRuntimeEnvironmentOutput(output: string): string[] {
  const updated: string[] = [];
  const observed = new Set<string>();

  for (const line of output.split("\n")) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const name = line.slice(0, separatorIndex);
    if (!RUNTIME_ENV_VARIABLES.has(name)) {
      continue;
    }
    observed.add(name);

    const value = line.slice(separatorIndex + 1);
    if (value.length === 0) {
      if (RUNTIME_ENV_CREDENTIAL_VARIABLES.has(name) && process.env[name] !== undefined) {
        delete process.env[name];
        updated.push(name);
      }
      continue;
    }
    if (process.env[name] === value) {
      continue;
    }

    process.env[name] = value;
    updated.push(name);
  }

  for (const name of RUNTIME_ENV_CREDENTIAL_VARIABLES) {
    if (!observed.has(name) && process.env[name] !== undefined) {
      delete process.env[name];
      updated.push(name);
    }
  }

  return updated;
}

export async function refreshRuntimeEnvironment(run: typeof execFile = execFile): Promise<void> {
  try {
    const runtimeEnvScript = getRuntimeEnvironmentScriptPath();
    const { stdout } = await run(
      "/bin/sh",
      [
        "-c",
        `if [ -f "$${RUNTIME_ENV_SCRIPT_ENV}" ]; then . "$${RUNTIME_ENV_SCRIPT_ENV}" 2>/dev/null || true; orkestrator_source_runtime_env 2>/dev/null || true; fi; env`,
      ],
      {
        env: {
          ...process.env,
          [RUNTIME_ENV_SCRIPT_ENV]: runtimeEnvScript,
        },
        maxBuffer: 256 * 1024,
      },
    );

    const updated = applyRuntimeEnvironmentOutput(stdout);
    if (updated.length > 0) {
      // Names only. These values contain private paths and credentials.
      console.error("[codex-bridge] Refreshed runtime environment:", updated.join(", "));
    }
  } catch (error) {
    console.error("[codex-bridge] Failed to refresh runtime environment:", error);
  }
}

/**
 * Stable digest of the values a persistent Codex child captured at launch.
 *
 * Compared against the running generation's launch fingerprint to decide whether
 * the child is serving stale tools or credentials. Only the digest is ever
 * logged or exposed through health — never the underlying values.
 */
export function fingerprintRuntimeEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  const hash = createHash("sha256");
  for (const name of [...RUNTIME_ENV_VARIABLES].sort()) {
    hash.update(name);
    hash.update("\0");
    hash.update(env[name] ?? "");
    hash.update("");
  }
  return `sha256:${hash.digest("hex").slice(0, 32)}`;
}

/** The subset of `process.env` a Codex child should be launched with. */
export function runtimeEnvironmentSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...env };
}

/** A child environment for bridge helpers that must not receive managed credentials. */
export function runtimeEnvironmentWithoutCredentials(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const snapshot = runtimeEnvironmentSnapshot(env);
  for (const name of RUNTIME_ENV_CREDENTIAL_VARIABLES) {
    delete snapshot[name];
  }
  return snapshot;
}
