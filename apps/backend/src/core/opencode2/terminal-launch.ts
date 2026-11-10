/**
 * OpenCode terminal tabs on OpenCode 2 (docs/todo/agent-engines/0008-opencode-v2.md).
 *
 * A terminal tab's launch line is built for 1.x
 * (`buildTerminalAgentLaunchCommand`): a bare `opencode`, found on the login
 * shell's PATH, with `--model` and `--prompt`. With "Use OpenCode 2 for new
 * sessions" on, a local environment's new OpenCode tab instead runs the
 * managed `opencode2`, rewritten here when the tab is bootstrapped:
 *
 * - **The managed binary by its full path.** macOS's login shell reorders
 *   PATH (`path_helper`) and puts the managed toolchain behind Homebrew and
 *   version-manager shims, so a bare name reaches whatever the user installed.
 *   That is how a user's own 2.x `opencode` received 1.x's `--model` and
 *   printed its usage instead of starting.
 * - **`--standalone`.** Without it the 2.x TUI starts or joins a background
 *   service that outlives the tab and keeps whatever environment it was first
 *   started with.
 * - **The model through `OPENCODE_CONFIG_CONTENT`.** The 2.x TUI has no
 *   `--model` (only `opencode run` does); a `model` in inline config selects it
 *   (verified on 2.2.6). The reasoning level stays out, as it does for 1.x.
 * - **The host 2.x server's storage and configuration** (`server.ts`): the
 *   same private database (so sign-ins Orkestrator mirrors into it reach the
 *   tab, and the user's `opencode.db` is never migrated), config directory,
 *   flags and autoupdate guard. Server credentials a shell may export are
 *   unset, and a user `OPENCODE_CONFIG` reaches 2.x only as its mirror.
 */
import { resolveOpenCodeProtocol } from "@orkestrator/protocol/opencode-protocol";
import { quoteShell } from "../commands-agent-support.js";
import { OPENCODE2_FLAGS, openCode2HostPaths } from "./server.js";

/** Shell variables that must not reach a 2.x terminal TUI or its private server. */
const UNSET_IN_TERMINAL = [
  "OPENCODE_CONFIG",
  "OPENCODE_PASSWORD",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
] as const;

export interface OpenCode2TerminalLaunchInput {
  cliPath: string;
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
  ];
  if (input.mirroredUserConfig) assignments.push(["OPENCODE_CONFIG", paths.customConfig]);
  const model = input.model && input.model !== "default" ? input.model : undefined;
  if (model) assignments.push(["OPENCODE_CONFIG_CONTENT", JSON.stringify({ model })]);
  const args = [
    "env",
    ...UNSET_IN_TERMINAL.flatMap((name) => ["-u", name]),
    ...assignments.map(([name, value]) => `${name}=${quoteShell(value)}`),
    quoteShell(input.cliPath),
    "--standalone",
  ];
  if (input.initialPrompt) args.push("--prompt", quoteShell(input.initialPrompt));
  return args.join(" ");
}

/** Shown in the tab, instead of a launch, when the setting asks for 2.x and none is installed. */
export function openCode2TerminalUnavailableCommand(message: string): string {
  return `printf '%s\\n' ${quoteShell(message)}`;
}

export interface OpenCode2TerminalContext {
  storage: {
    getDataDir(): string;
    getEnvironment(id: string): Promise<{ environmentType?: string } | null>;
    loadConfig(): Promise<{ global: { openCodeProtocol?: unknown } }>;
  };
  /** The managed `opencode2`, or undefined when the toolchain has none. */
  resolveCliPath(): string | undefined;
  /** Writes the shared 2.x config directory (`writeOpenCode2HostConfig`). */
  writeConfig(dataDir: string, env: NodeJS.ProcessEnv): Promise<string>;
  env?: NodeJS.ProcessEnv;
}

/**
 * The line a new OpenCode tab of this local environment runs instead of the
 * 1.x launch, or undefined to keep 1.x: the setting is off, the environment is
 * not a local one, or either could not be read (the same default
 * `selectNewOpenCodeSessionProtocol` keeps). With the setting on and no
 * managed 2.x binary, the tab says so rather than running a 1.x it was not
 * asked for.
 */
export async function resolveOpenCode2TerminalCommand(
  context: OpenCode2TerminalContext,
  environmentId: string,
  launch: { model?: string; initialPrompt?: string },
): Promise<string | undefined> {
  let wantsV2: boolean;
  try {
    const [environment, config] = await Promise.all([
      context.storage.getEnvironment(environmentId),
      context.storage.loadConfig(),
    ]);
    wantsV2 =
      environment?.environmentType === "local" &&
      resolveOpenCodeProtocol(config.global.openCodeProtocol) === "v2";
  } catch {
    return undefined;
  }
  if (!wantsV2) return undefined;
  const cliPath = context.resolveCliPath();
  if (!cliPath) {
    return openCode2TerminalUnavailableCommand(
      "OpenCode 2 is not installed yet. Restart Orkestrator to finish downloading it, " +
        "or turn off “Use OpenCode 2 for new sessions” in Settings.",
    );
  }
  const env = context.env ?? process.env;
  const dataDir = context.storage.getDataDir();
  const configDir = await context.writeConfig(dataDir, env);
  return buildOpenCode2TerminalCommand({
    cliPath,
    dataDir,
    configDir,
    mirroredUserConfig: Boolean(env.OPENCODE_CONFIG?.trim()),
    ...launch,
  });
}
