/**
 * OpenCode terminal tabs in a container (OpenCode 2's TUI).
 *
 * A terminal tab's launch line is built by the renderer
 * (`buildTerminalAgentLaunchCommand`): a bare `opencode` with `--model` and
 * `--prompt`, typed into the container's interactive shell. The image's
 * OpenCode is 2.x only, so a container tab's canonical OpenCode launch is
 * rewritten here when the tab is bootstrapped, the container twin of
 * `terminal-launch.ts`:
 *
 * - **The image's 2.x binary by its path** ({@link OPENCODE2_CONTAINER_CLI_PATH}).
 *   On an image built before OpenCode 1.x was retired, a bare `opencode` is
 *   still 1.x; an image with no 2.x at all says so in the tab instead.
 * - **`--standalone`.** Without it the TUI starts or joins a background
 *   service that outlives the tab and keeps whatever environment it was first
 *   started with.
 * - **The model through `OPENCODE_CONFIG_CONTENT`.** The TUI has no `--model`
 *   (only `opencode run` does); a `model` in inline config selects it
 *   (verified on 2.2.6). The reasoning level stays out.
 * - **The container server's storage and configuration**
 *   (`opencode2-container-launch.ts`, `container-server.ts`): its database
 *   (`opencode2.db`, on the persistent mount when the runtime has one), so
 *   the sessions and the sign-ins Orkestrator stores there reach the tab and
 *   1.x's `opencode.db` is never migrated; its configuration directory, which
 *   holds Orkestrator's plugins and the user's configuration (root's copy on
 *   an `opencode2-launch=1` image, node's on an older one), and the user's
 *   own `~/.config/opencode` before the server has ever started; the same
 *   flags and autoupdate and file-watcher guards. Server credentials a shell
 *   may export are unset.
 *
 * Everything is set inside a subshell, so nothing reaches the tab's shell
 * once OpenCode exits. A root terminal is never rewritten: root must not run
 * the binary through a path the agent's uid can write.
 */
import { parseTerminalOpenCodeLaunchCommand } from "@orkestrator/protocol/terminal-agent-launch";
import { OPENCODE2_LAUNCH_CONFIG_DIR } from "../agent-credential-files.js";
import { quoteShell } from "../commands-agent-support.js";
import { persistentStateExports } from "../container-state-layout.js";
import {
  OPENCODE2_CONTAINER_CLI_PATH,
  OPENCODE2_CONTAINER_CONFIG_DIR,
} from "./container-server.js";
import { OPENCODE2_DISABLE_FILEWATCHER, OPENCODE2_FLAGS } from "./server.js";

/** The image's Bun, run from `/` with no `.env` of the working directory. */
const CONTAINER_BUN = "/usr/local/bin/bun";

/** Shell variables that must not reach a 2.x terminal TUI or its private server. */
const UNSET_IN_TERMINAL = [
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_PASSWORD",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
] as const;

/**
 * The configuration directories a container's 2.x server uses, in the order
 * the tab prefers them: root's on an `opencode2-launch=1` image, node's on an
 * older one.
 */
export const OPENCODE2_CONTAINER_TERMINAL_CONFIG_DIRS = [
  OPENCODE2_LAUNCH_CONFIG_DIR,
  OPENCODE2_CONTAINER_CONFIG_DIR,
] as const;

export const OPENCODE2_CONTAINER_TERMINAL_UNAVAILABLE =
  "This container's image has no OpenCode 2. Rebuild the environment on a current image to use OpenCode.";

/** The command line, without a line ending, that starts a 2.x TUI in a container tab. */
export function buildOpenCode2ContainerTerminalCommand(launch: {
  model?: string;
  initialPrompt?: string;
}): string {
  const model = launch.model && launch.model !== "default" ? launch.model : undefined;
  const assignments: Array<[string, string]> = [
    ["OPENCODE_DISABLE_AUTOUPDATE", "1"],
    ["OPENCODE_FLAGS", OPENCODE2_FLAGS],
    ...Object.entries(OPENCODE2_DISABLE_FILEWATCHER),
  ];
  const args = [
    "exec",
    "env",
    ...assignments.map(([name, value]) => `${name}=${quoteShell(value)}`),
    quoteShell(OPENCODE2_CONTAINER_CLI_PATH),
    "--standalone",
  ];
  if (launch.initialPrompt) args.push("--prompt", quoteShell(launch.initialPrompt));
  const steps = [
    `unset ${UNSET_IN_TERMINAL.join(" ")}`,
    persistentStateExports("opencode2"),
    `for dir in ${OPENCODE2_CONTAINER_TERMINAL_CONFIG_DIRS.map(quoteShell).join(" ")}; do if [ -d "$dir" ]; then export OPENCODE_CONFIG_DIR="$dir"; break; fi; done`,
  ];
  if (model) {
    // Merge at shell execution time: the container's shell can export inline
    // config of its own. `&&` keeps a malformed one from starting the agent
    // without the chosen model.
    // One line: it is typed into the tab's interactive shell.
    const merge = [
      "try {",
      'const config = Bun.JSONC.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}");',
      'if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error();',
      `process.stdout.write(JSON.stringify({ ...config, model: ${JSON.stringify(model)} }));`,
      "} catch {",
      'process.stderr.write("OpenCode inline configuration must be a JSONC object.\\n");',
      "process.exitCode = 1;",
      "}",
    ].join(" ");
    // Not from the checkout: its bunfig preloads and .env would run here.
    steps.push(
      `OPENCODE_CONFIG_CONTENT="$(cd / && ${CONTAINER_BUN} --no-env-file --eval ${quoteShell(merge)})" && export OPENCODE_CONFIG_CONTENT && ${args.join(" ")}`,
    );
  } else {
    steps.push(args.join(" "));
  }
  const cli = quoteShell(OPENCODE2_CONTAINER_CLI_PATH);
  const unavailable = `printf '%s\\n' ${quoteShell(OPENCODE2_CONTAINER_TERMINAL_UNAVAILABLE)}`;
  return `( if [ -x ${cli} ]; then ${steps.join("; ")}; else ${unavailable}; fi )`;
}

/**
 * The line a container terminal runs for `terminalData`: the 2.x TUI for the
 * renderer's canonical OpenCode launch in a terminal of the agent's own user,
 * otherwise `terminalData` unchanged (a plain command, a user's own
 * `opencode` with other flags, or a root terminal).
 */
export function containerOpenCodeTerminalCommand(terminalData: string, user?: string): string {
  if (user !== undefined && user !== "node") return terminalData;
  const launch = parseTerminalOpenCodeLaunchCommand(terminalData);
  if (!launch) return terminalData;
  return `${buildOpenCode2ContainerTerminalCommand(launch)}${launch.lineEnding}`;
}
