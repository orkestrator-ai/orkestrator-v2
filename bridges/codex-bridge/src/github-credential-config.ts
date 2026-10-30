/**
 * Withholding the GitHub credential from a Codex thread (graphs item 209).
 *
 * One `codex app-server` serves every session of an environment, so the
 * child's own environment cannot drop the credential for one session. What a
 * thread can change is the environment Codex builds for each command it runs:
 * `shell_environment_policy`, which `thread/start`, `thread/resume` and
 * `thread/fork` accept as thread configuration. Codex applies it in a fixed
 * order (inherit, default excludes, `exclude`, `set`, `include_only`), so the
 * thread excludes every credential variable and then sets the replacements:
 * an empty `GH_CONFIG_DIR` and Git configuration entries that reset the
 * credential helpers. Verified against 0.166.0 by
 * `app-server/live-github-credential.test.ts` (no credits).
 *
 * The inherited `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*`
 * entries are excluded too, and the resets are numbered from 0. Appending
 * after an inherited count would break under `inherit = "core"` (a
 * coordinator process), where the inherited entries are already gone and Git
 * refuses a count with missing keys; copying them into the thread
 * configuration would write whatever they hold (an `http.extraheader` can
 * carry a token) into a request the rollout may keep.
 *
 * What it cannot withhold: the app-server process itself keeps the credential
 * (it is the same process for every session), so a command that reads its
 * parent's environment (`/proc/<pid>/environ` on Linux) still finds it, and
 * neither MCP servers nor hooks take their environment from this policy. A
 * stdio MCP server gets only Codex's small default set plus the variables its
 * own entry names, and a graph node loads no user server it was not granted
 * (item 404). The remote-ref guard is the backstop.
 */
import {
  nativeAgentWithholdsGitHubCredential,
  withheldGitHubCredentialEnvironment,
  WITHHELD_GITHUB_ENV_VARS,
  type NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Inherited Git configuration-by-environment entries a withheld thread replaces. */
export const CODEX_INHERITED_GIT_CONFIG_PATTERNS = Object.freeze([
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_*",
  "GIT_CONFIG_VALUE_*",
]);

/** The process-level `shell_environment_policy.exclude` override, if any. */
export function codexProcessShellExclude(
  configOverrides: Readonly<Record<string, string>> | undefined,
): string[] {
  const raw = configOverrides?.["shell_environment_policy.exclude"];
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Thread configuration that keeps the GitHub credential out of every command
 * a thread runs when its policy denies `github.write` (every graph agent
 * node); empty otherwise.
 *
 * `processExclude` is the process's own exclude list (a coordinator's): a
 * thread value replaces the process value rather than adding to it, so the
 * thread repeats it. Dotted keys, so `inherit` and `ignore_default_excludes`
 * keep their process values.
 */
export function codexGitHubCredentialThreadConfig(
  policy: Pick<NativeAgentExecutionPolicy, "capabilityPolicy"> | undefined,
  options: { ghConfigDir: string; processExclude?: readonly string[] },
): Record<string, unknown> {
  if (!nativeAgentWithholdsGitHubCredential(policy)) return {};
  const exclude = [
    ...new Set([
      ...(options.processExclude ?? []),
      ...WITHHELD_GITHUB_ENV_VARS,
      ...CODEX_INHERITED_GIT_CONFIG_PATTERNS,
    ]),
  ];
  // Applied to an empty environment, the shared helper yields exactly the
  // replacements: `GH_CONFIG_DIR` and the helper resets numbered from 0.
  const set = Object.fromEntries(
    Object.entries(
      withheldGitHubCredentialEnvironment({}, { ghConfigDir: options.ghConfigDir }),
    ).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  return {
    "shell_environment_policy.exclude": exclude,
    "shell_environment_policy.set": set,
  };
}

let withheldGhConfigDir: Promise<string> | undefined;

/** An empty `gh` configuration directory shared by every withheld thread of this process. */
export function emptyGhConfigDir(): Promise<string> {
  withheldGhConfigDir ??= mkdtemp(join(tmpdir(), "orkestrator-gh-withheld-")).catch(
    (error: unknown) => {
      withheldGhConfigDir = undefined;
      throw error;
    },
  );
  return withheldGhConfigDir;
}
