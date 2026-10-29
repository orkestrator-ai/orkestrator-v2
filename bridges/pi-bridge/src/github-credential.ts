/**
 * Withholding the GitHub credential from a Pi session (graphs item 209).
 *
 * Pi's SDK runs inside this bridge, so the bridge process keeps the
 * credential for every session it serves. What a session can lose is the
 * credential in what it starts:
 *
 * - **Shell commands.** The session's `bash` and `powershell` tools are
 *   replaced by the SDK's own definitions with a `spawnHook` that rewrites
 *   each command's environment (`withheldGitHubCredentialEnvironment`): no
 *   token variables, no managed credential file path, an empty
 *   `GH_CONFIG_DIR` and reset Git credential helpers. An SDK custom tool wins
 *   over the built-in and over an extension's tool of the same name, and
 *   `codemode` scripts reach the same registrations.
 * - **MCP servers the bridge starts** (`mcp.ts`): a stdio server is spawned
 *   with the same environment, and `$NAME` references in `mcp.json` resolve
 *   against it, so an entry that names a credential variable is skipped as
 *   unresolvable. A credential written literally into an entry is the user's
 *   own configuration and still reaches that server, which a graph node only
 *   loads when it was granted (item 404).
 *
 * What keeps it: Pi extensions (project resources on) run in this process
 * and can read its environment or spawn with it, and any command can read an
 * ancestor's environment (`/proc/<pid>/environ` on Linux). Withholding is
 * defence in depth; the remote-ref guard is the backstop.
 */
import type { BashSpawnContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  nativeAgentWithholdsGitHubCredential,
  withheldGitHubCredentialEnvironment,
  type NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashToolDefinition, createPowerShellToolDefinition } from "./pi-sdk.js";

export interface WithheldGitHubCredential {
  /** The empty directory `GH_CONFIG_DIR` points at. */
  ghConfigDir: string;
}

let withheldGhConfigDir: Promise<string> | undefined;

/** An empty `gh` configuration directory shared by every withheld session of this process. */
export function emptyGhConfigDir(): Promise<string> {
  withheldGhConfigDir ??= mkdtemp(join(tmpdir(), "orkestrator-gh-withheld-")).catch(
    (error: unknown) => {
      withheldGhConfigDir = undefined;
      throw error;
    },
  );
  return withheldGhConfigDir;
}

/**
 * What a session with `policy` withholds, or `undefined` when its policy
 * allows GitHub writes and it keeps the credential.
 */
export async function piWithheldGitHubCredential(
  policy: Pick<NativeAgentExecutionPolicy, "capabilityPolicy"> | undefined,
  ghConfigDir: () => Promise<string> = emptyGhConfigDir,
): Promise<WithheldGitHubCredential | undefined> {
  if (!nativeAgentWithholdsGitHubCredential(policy)) return undefined;
  return { ghConfigDir: await ghConfigDir() };
}

/** `env` without the GitHub credential. */
export function withheldEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  withheld: WithheldGitHubCredential,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    withheldGitHubCredentialEnvironment(env, { ghConfigDir: withheld.ghConfigDir }),
  )) {
    if (value !== undefined) next[key] = value;
  }
  return next;
}

/** A spawn hook that keeps the GitHub credential out of one command. */
export function withheldSpawnHook(
  withheld: WithheldGitHubCredential,
): (context: BashSpawnContext) => BashSpawnContext {
  return (context) => ({ ...context, env: withheldEnvironment(context.env, withheld) });
}

/**
 * The shell tools of a withheld session: the SDK's own `bash` (with the
 * settings Pi's built-in reads: command prefix and shell path) and
 * `powershell`, each with {@link withheldSpawnHook}. `defaultActive: false`,
 * so whether each is active follows the session's tool names exactly as the
 * built-ins would; registering a custom tool otherwise activates it.
 */
export function withheldShellToolDefinitions(
  cwd: string,
  withheld: WithheldGitHubCredential,
  settings: { commandPrefix?: string; shellPath?: string },
): ToolDefinition[] {
  const spawnHook = withheldSpawnHook(withheld);
  return [
    {
      ...createBashToolDefinition(cwd, {
        ...(settings.commandPrefix ? { commandPrefix: settings.commandPrefix } : {}),
        ...(settings.shellPath ? { shellPath: settings.shellPath } : {}),
        spawnHook,
      }),
      defaultActive: false,
    },
    { ...createPowerShellToolDefinition(cwd, { spawnHook }), defaultActive: false },
  ] as ToolDefinition[];
}
