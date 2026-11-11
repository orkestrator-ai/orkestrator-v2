/**
 * OpenCode terminal tabs (OpenCode 2's TUI).
 *
 * A terminal tab's launch line is built by the renderer
 * (`buildTerminalAgentLaunchCommand`): a bare `opencode`, found on the login
 * shell's PATH, with `--model` and `--prompt`. A local environment's OpenCode
 * tab instead runs the managed `opencode2`, rewritten here when the tab is
 * bootstrapped:
 *
 * - **The managed binary by its full path.** macOS's login shell reorders
 *   PATH (`path_helper`) and puts the managed toolchain behind Homebrew and
 *   version-manager shims, so a bare name reaches whatever the user installed.
 * - **`--standalone`.** Without it the TUI starts or joins a background
 *   service that outlives the tab and keeps whatever environment it was first
 *   started with.
 * - **The model through `OPENCODE_CONFIG_CONTENT`.** The TUI has no `--model`
 *   (only `opencode run` does); a `model` in inline config selects it
 *   (verified on 2.2.6). The reasoning level stays out.
 * - **The host server's storage and configuration** (`server.ts`): the same
 *   private database (so sign-ins Orkestrator makes reach the tab, and the
 *   user's own `opencode.db` is never migrated), config directory, flags and
 *   autoupdate and file-watcher guards. Server credentials a shell may export
 *   are unset, and a user `OPENCODE_CONFIG` reaches OpenCode only as its
 *   mirror.
 */
import { quoteShell } from "../commands-agent-support.js";
import { OPENCODE2_DISABLE_FILEWATCHER, OPENCODE2_FLAGS, openCode2HostPaths } from "./server.js";

/** Shell variables that must not reach a 2.x terminal TUI or its private server. */
const UNSET_IN_TERMINAL = [
  "OPENCODE_CONFIG",
  "OPENCODE_PASSWORD",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
] as const;

export interface OpenCode2TerminalLaunchInput {
  cliPath: string;
  bunPath: string;
  dataDir: string;
  configDir: string;
  /** Whether the backend's `OPENCODE_CONFIG` was mirrored (`writeOpenCode2HostConfig`). */
  mirroredUserConfig: boolean;
  model?: string;
  initialPrompt?: string;
}

/** The command line, without a line ending, that starts a 2.x TUI in a terminal tab. */
export function buildOpenCode2TerminalCommand(input: OpenCode2TerminalLaunchInput): string {
  const paths = openCode2HostPaths(input.dataDir);
  const assignments: Array<[string, string]> = [
    ["OPENCODE_DISABLE_AUTOUPDATE", "1"],
    ["OPENCODE_FLAGS", OPENCODE2_FLAGS],
    ["OPENCODE_DB", paths.database],
    ["OPENCODE_CONFIG_DIR", input.configDir],
    ...Object.entries(OPENCODE2_DISABLE_FILEWATCHER),
  ];
  if (input.mirroredUserConfig) assignments.push(["OPENCODE_CONFIG", paths.customConfig]);
  const model = input.model && input.model !== "default" ? input.model : undefined;
  const args = [
    "env",
    ...UNSET_IN_TERMINAL.flatMap((name) => ["-u", name]),
    ...assignments.map(([name, value]) => `${name}=${quoteShell(value)}`),
    quoteShell(input.cliPath),
    "--standalone",
  ];
  if (input.initialPrompt) args.push("--prompt", quoteShell(input.initialPrompt));
  const command = args.join(" ");
  if (!model) return command;
  // Merge at shell execution time: a login shell can export different inline
  // config than the backend inherited. A subshell confines the override to this
  // launch; && prevents starting the agent with lost settings on malformed input.
  const merge = `try {
    const config = Bun.JSONC.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}");
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error();
    process.stdout.write(JSON.stringify({ ...config, model: ${JSON.stringify(model)} }));
  } catch {
    process.stderr.write("OpenCode inline configuration must be a JSONC object.\\n");
    process.exitCode = 1;
  }`;
  // Do not load this worktree's bunfig preloads or .env while merging config.
  const merged = `$(cd / && ${quoteShell(input.bunPath)} --no-env-file --eval ${quoteShell(merge)})`;
  return `( OPENCODE_CONFIG_CONTENT="${merged}" && export OPENCODE_CONFIG_CONTENT && ${command} )`;
}

/** Shown in the tab, instead of a launch, when the managed binary is not installed. */
export function openCode2TerminalUnavailableCommand(message: string): string {
  return `printf '%s\\n' ${quoteShell(message)}`;
}

export interface OpenCode2TerminalContext {
  storage: {
    getDataDir(): string;
    getEnvironment(id: string): Promise<{ environmentType?: string } | null>;
  };
  /** The managed `opencode2`, or undefined when the toolchain has none. */
  resolveCliPath(): string | undefined;
  resolveBunPath(): string;
  /** Writes the shared 2.x config directory (`writeOpenCode2HostConfig`). */
  writeConfig(dataDir: string, env: NodeJS.ProcessEnv): Promise<string>;
  env?: NodeJS.ProcessEnv;
}

/**
 * The line a new OpenCode tab of this local environment runs, or undefined
 * for a tab that is not a local environment's (or whose environment could not
 * be read), which keeps the renderer's line. With no managed binary the tab
 * says so rather than running whatever `opencode` the user installed.
 */
export async function resolveOpenCode2TerminalCommand(
  context: OpenCode2TerminalContext,
  environmentId: string,
  launch: { model?: string; initialPrompt?: string },
): Promise<string | undefined> {
  try {
    const environment = await context.storage.getEnvironment(environmentId);
    if (environment?.environmentType !== "local") return undefined;
  } catch {
    return undefined;
  }
  const cliPath = context.resolveCliPath();
  if (!cliPath) {
    return openCode2TerminalUnavailableCommand(
      "OpenCode is not installed yet. Restart Orkestrator to finish downloading it.",
    );
  }
  const env = context.env ?? process.env;
  const dataDir = context.storage.getDataDir();
  const configDir = await context.writeConfig(dataDir, env);
  return buildOpenCode2TerminalCommand({
    cliPath,
    bunPath: context.resolveBunPath(),
    dataDir,
    configDir,
    mirroredUserConfig: Boolean(env.OPENCODE_CONFIG?.trim()),
    ...launch,
  });
}
