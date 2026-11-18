/**
 * How a host OpenCode 2.x server is launched (to-do 0008, retired (`git show 17d28238c:docs/todo/agent-engines/0008-opencode-v2.md`),
 * build plan phases 2 and 3). Pure launch description plus the files it needs;
 * the process itself is started by the local-server supervisor.
 *
 * - **Its own database.** 2.x migrates `opencode.db` in place, and a 1.x
 *   server or the user's own 1.x TUI must never open a migrated one. The
 *   2.x server therefore gets `OPENCODE_DB` under Orkestrator's data
 *   directory. Credentials in the user's `auth.json` are imported into it once,
 *   on first start (2.x behaviour).
 * - **The password stays out of the agent's tools.** The server reads
 *   `OPENCODE_PASSWORD` once at startup. Without the credential plugin, a tool
 *   inherits it, so the agent could call its own server's API. Observed live
 *   on 2.2.6: the shell tool printed it. The 2.x plugin
 *   ({@link buildOpenCode2CredentialPluginSource}) removes it from the
 *   process and from every shell the server creates. 1.x plugins do not run
 *   on 2.x, which is why this is a separate plugin.
 * - **The user's global configuration, mirrored.** `OPENCODE_CONFIG_DIR`
 *   replaces 2.x's global directory, so the user's `~/.config/opencode` is
 *   mirrored into it read-only and without plugins (`user-config.ts`), and
 *   the backend's `OPENCODE_CONFIG` is passed as its mirror.
 * - **Pinned behaviour.** `OPENCODE_DISABLE_AUTOUPDATE` keeps the pinned
 *   binary, and `OPENCODE_FLAGS` names every feature flag of the pin
 *   explicitly. Automations (2.3.1's scheduled tasks) and Console watches
 *   stay off, because they wake sessions with prompts Orkestrator never
 *   sent. A flag added by a later pin is off in releases unless named here.
 *   Background compaction is a configuration key since 2.3.1 and keeps
 *   OpenCode's default, on ({@link OPENCODE2_FLAGS} has its cost).
 * - **No file watchers.** `OPENCODE_DISABLE_FILEWATCHER` turns off the
 *   watchers each location boots: one per ancestor directory of the worktree
 *   up to `/`, the config directory and `.git/HEAD`. On macOS each one took
 *   0.2 to 5 s to start under Bun's `fs.watch`, so the first request in a
 *   worktree (`/api/model`, a session) waited 6 to 8 s, and as long again on
 *   shutdown while they closed (measured on 2.2.6; see
 *   {@link OPENCODE2_DISABLE_FILEWATCHER}). They only live-reload
 *   configuration, skills and `AGENTS.md`, which Orkestrator writes before
 *   the server starts.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { ProviderUnavailableError } from "../agent-provider-contract.js";
import { OPENCODE_LAUNCH_ENVIRONMENT_SOURCE } from "../agent-credential-files.js";
import type { OpenCode2Client } from "./client.js";
import type { OpenCode2Info } from "./types.js";
import { mirrorOpenCodeUserConfig } from "./user-config.js";

const log = createLogger("native-agent.opencode2");

export const OPENCODE2_CREDENTIAL_PLUGIN_ID = "orkestrator-credential";
/**
 * Every 2.3.1 feature flag, on or off by name (`packages/schema/src/config/flag.ts`).
 * An unknown name is ignored, so a flag a release removed must be dropped
 * here rather than left behind.
 *
 * - `todo` on; `automations` off (2.3.1's name for `schedules`, which it
 *   still reads as an alias: it wakes sessions with prompts Orkestrator never
 *   sent), as are `artifacts`, `media_blob`, `console_watches` (Console
 *   watches that wake sessions) and `mcp_events` (a draft MCP extension
 *   Orkestrator does not read).
 * - 2.3.1 added `video_generate` (an experimental video API) and
 *   `full_codemode` (opt-in only, off in every build anyway), both off.
 * - 2.3.1 removed `shell_timeout_background`: a foreground shell still
 *   running when its timeout expires now always moves to the background and
 *   reports to its session when it ends, waking it. The provider treats it as
 *   background work (`background-subagents.ts`). A foreground `timeout: 0`
 *   now means the default 120 s.
 * - 2.3.1 removed `background_compaction` (and the `experimental` setting
 *   behind it) in favour of the configuration key `compaction.background`,
 *   described below.
 *
 * **Background compaction** is left at OpenCode 2.3.1's own default, on.
 * Orkestrator writes no setting for it, so the user's own global OpenCode
 * configuration (mirrored by `user-config.ts`) can still turn it off with
 * `"compaction": { "background": false }`.
 *
 * What it does: once a session's context is within 60k tokens of its
 * automatic-compaction threshold (at most halfway there on a small window),
 * OpenCode writes the summary in the background from the prompt cache and
 * holds it, so the run that reaches the threshold swaps it in instead of
 * pausing 30 to 60 s to summarise. It adds no history rows, wakes nothing and
 * does not change the session's status, so activity, workflows and the
 * transcript are unaffected. A held summary lives in the server's memory and
 * is lost when the server restarts.
 *
 * What it costs: one extra model request per compaction cycle on the
 * session's model (or `agents.compaction.model`), reading the conversation so
 * far, mostly from the prompt cache, and writing a summary. It is billed when
 * it finishes (OpenCode records it as compaction usage) whether or not it is
 * ever used. It goes unused when the session ends, is archived or goes quiet
 * before reaching the threshold (common for a pipeline or review turn that
 * finishes near the end of a long context), when the conversation grows more
 * than about 40% of the threshold past it, when its start changes, or when
 * the server restarts. OpenCode skips it after a model switch, after a pause
 * longer than the prompt cache lifetime and for native compaction, and stops
 * starting new ones after two failures until the next compaction.
 *
 * It is kept on because without it a long agent turn stalls for the summary
 * in the middle of its work, which the user waits through, and the cost is
 * bounded to at most one summary per cycle that a session nearly completes.
 */
export const OPENCODE2_FLAGS =
  "todo,-automations,-artifacts,-media_blob,-video_generate,-console_watches,-mcp_events,-full_codemode";
/**
 * Set on every 2.x process Orkestrator starts (servers and terminal TUIs).
 * Measured on 2.2.6 in a worktree on macOS: location boot 6,183 ms with the
 * watchers and 39 ms without, the first `/api/model` 7.25 s against 0.24 s,
 * and shutdown 7.4 s against 0.07 s.
 */
export const OPENCODE2_DISABLE_FILEWATCHER = { OPENCODE_DISABLE_FILEWATCHER: "1" } as const;

/**
 * The host plugin's parent watch (to-do 8045 (retired)): the server stops
 * itself, gracefully, once the backend that started it is gone, as every
 * bridge does through `ORKESTRATOR_PARENT_PID` (`@orkestrator/protocol`'s
 * `parent-watchdog.ts`; same one-second probe, same rule that PID 1 or an
 * unparseable value means no parent to watch).
 *
 * `opencode serve` has no watch of its own. A killed backend's server used
 * to be stopped only by the next backend's reaper, which then skipped a
 * process whose parent was alive; on Linux an orphan is adopted by a live
 * subreaper (`systemd --user`), so the reaper skipped it and the old server
 * ran on beside the new one, on the same database, finishing a turn the
 * restarted backend had already given its continuation. The reaper now reaps
 * an orphan whose live parent is the `systemd` subreaper (`liveParentRole` in
 * `local-server-reaper.ts`, to-dos 8101 and 8093, retired) and still leaves
 * any other live parent alone, but it runs only when the next backend
 * starts, so the watch is still what stops a turn promptly. Stopping on
 * SIGTERM lets 2.2.6 suspend the run exactly as the reaper's SIGTERM does,
 * which the provider then reports as a restart interruption (`restart-cut.ts`).
 *
 * 2.2.6 loads a plugin when a location first runs a turn, so a server that
 * never ran one is left to the reaper; it holds no turn to lose. The
 * watch is armed once per process however many locations load the plugin.
 */
const OPENCODE2_PARENT_WATCH_SOURCE = `
function watchOrkestratorParent() {
  if (globalThis.__orkestratorParentWatch) return;
  const parent = Number.parseInt(process.env.ORKESTRATOR_PARENT_PID ?? "", 10);
  if (!Number.isInteger(parent) || parent <= 1) return;
  globalThis.__orkestratorParentWatch = true;
  const timer = setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch (error) {
      if (error && error.code === "EPERM") return;
      clearInterval(timer);
      process.kill(process.pid, "SIGTERM");
    }
  }, 1000);
  timer.unref?.();
}
`;

/**
 * A 2.x plugin needs only `{ id, setup }`; `Plugin.define` from
 * `@opencode/plugin` is a typed identity, so the source imports nothing and
 * no package has to be installed beside it. Verified on 2.2.6.
 *
 * `hardened: "refuse-tools"` is the container form. Deleting the variable
 * does not change `/proc/<pid>/environ`, which any process of the same uid
 * can read on Linux, so the plugin also marks the server non-dumpable, as the
 * retired 1.x plugin did, and refuses every tool when it cannot. The host form only removes the variable: a host
 * promises no boundary between the agent and the user's own processes
 * (docs/architecture/agent-approvals.md).
 */
export function buildOpenCode2CredentialPluginSource(
  options: { hardened?: "refuse-tools"; applyLaunchEnvironment?: boolean } = {},
): string {
  if (!options.hardened) {
    return `// Written by Orkestrator. Keeps the server password from this server's tools.
const NAMES = ["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"];
${OPENCODE2_PARENT_WATCH_SOURCE}
export default {
  id: ${JSON.stringify(OPENCODE2_CREDENTIAL_PLUGIN_ID)},
  async setup(ctx) {
    watchOrkestratorParent();
    for (const name of NAMES) delete process.env[name];
    await ctx.shell.hook("create.before", (event) => {
      for (const name of NAMES) delete event.env[name];
    });
  },
};
`;
  }
  // A server `orkestrator-bridge-launch opencode2` started runs under
  // `env -i`; the plugin applies the start script's environment for its
  // tools, as the 1.x plugin does (`agent-credential-files.ts`).
  const launch = options.applyLaunchEnvironment ? OPENCODE_LAUNCH_ENVIRONMENT_SOURCE : "";
  return `${launch}// Written by Orkestrator. Keeps the server password from this server's tools.
const NAMES = ["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"];
const PR_SET_DUMPABLE = 4;

async function markNonDumpable() {
  if (process.platform !== "linux") return true;
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const libc = dlopen("libc.so.6", {
      prctl: {
        args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
        returns: FFIType.i32,
      },
    });
    try {
      return libc.symbols.prctl(PR_SET_DUMPABLE, 0n, 0n, 0n, 0n) === 0;
    } finally {
      libc.close();
    }
  } catch {
    return false;
  }
}

export default {
  id: ${JSON.stringify(OPENCODE2_CREDENTIAL_PLUGIN_ID)},
  async setup(ctx) {
    for (const name of NAMES) delete process.env[name];
    if (!(await markNonDumpable())) {
      process.stderr.write("Orkestrator could not protect the OpenCode server password from this server's tools.\\n");
      await ctx.tool.hook("execute.before", () => {
        throw new Error("Refusing to run tools: Orkestrator could not protect this OpenCode server's password from them.");
      });
    }${options.applyLaunchEnvironment ? "\n    applyLaunchEnvironment();" : ""}
    await ctx.shell.hook("create.before", (event) => {
      for (const name of NAMES) delete event.env[name];
    });
  },
};
`;
}

/** The 2.x server's private state below Orkestrator's data directory. */
export function openCode2HostPaths(dataDir: string) {
  const root = path.join(dataDir, "opencode2");
  return {
    root,
    configDir: path.join(root, "config"),
    database: path.join(root, "opencode.db"),
    /** The mirror of the backend's `OPENCODE_CONFIG` file (`user-config.ts`). */
    customConfig: path.join(root, "opencode-config.jsonc"),
  };
}

/**
 * Write the config directory: the credential plugin, and a read-only mirror of
 * the user's global OpenCode configuration as `env` (the server's own
 * environment) locates it ({@link mirrorOpenCodeUserConfig}). Returns it.
 */
export async function writeOpenCode2HostConfig(
  dataDir: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const { configDir, customConfig } = openCode2HostPaths(dataDir);
  const pluginDir = path.join(configDir, "plugins", OPENCODE2_CREDENTIAL_PLUGIN_ID);
  await mkdir(pluginDir, { recursive: true, mode: 0o700 });
  const plugin = path.join(pluginDir, "index.ts");
  // A server starting alongside this one must never load half a file.
  const staged = `${plugin}.${randomUUID()}.tmp`;
  try {
    await writeFile(staged, buildOpenCode2CredentialPluginSource(), { mode: 0o600, flag: "wx" });
    await rename(staged, plugin);
  } finally {
    await rm(staged, { force: true });
  }
  try {
    await mirrorOpenCodeUserConfig({ configDir, customConfigFile: customConfig, env });
  } catch (error) {
    // The server still starts, with Orkestrator's plugins and project configuration.
    log.warn("user-config.mirror-failed", { error: formatLogError(error, { message: false }) });
  }
  return configDir;
}

export interface OpenCode2HostLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * The argv and environment for a host 2.x server. `baseEnv` is the
 * supervisor's common child environment; anything the user exported for
 * OpenCode 1.x that would change the 2.x server's storage or auth is replaced.
 */
export function openCode2HostLaunch(input: {
  cliPath: string;
  dataDir: string;
  configDir: string;
  port: number;
  password: string;
  baseEnv: Record<string, string | undefined>;
}): OpenCode2HostLaunch {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.baseEnv)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.OPENCODE_SERVER_USERNAME;
  delete env.OPENCODE_SERVER_PASSWORD;
  Object.assign(env, {
    OPENCODE_PASSWORD: input.password,
    OPENCODE_DB: openCode2HostPaths(input.dataDir).database,
    OPENCODE_CONFIG_DIR: input.configDir,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_FLAGS: OPENCODE2_FLAGS,
    ...OPENCODE2_DISABLE_FILEWATCHER,
  });
  // The user's own file reaches 2.x only as its mirror, without plugins.
  if (env.OPENCODE_CONFIG?.trim()) {
    env.OPENCODE_CONFIG = openCode2HostPaths(input.dataDir).customConfig;
  } else {
    delete env.OPENCODE_CONFIG;
  }
  return {
    command: input.cliPath,
    args: ["serve", "--hostname", "127.0.0.1", "--port", String(input.port)],
    env,
  };
}

/**
 * Wait until `/api/info` answers as a 2.x server. A 1.x server or the bundled
 * web app on the port never counts (the client refuses HTML and non-2.x answers).
 */
export async function waitForOpenCode2Ready(
  client: Pick<OpenCode2Client, "info">,
  options: {
    timeoutMs: number;
    intervalMs?: number;
    signal?: AbortSignal;
    isAlive?: () => boolean;
  },
): Promise<OpenCode2Info> {
  const deadline = Date.now() + options.timeoutMs;
  let lastError: unknown;
  for (;;) {
    if (options.signal?.aborted)
      throw new ProviderUnavailableError("OpenCode 2.x startup was cancelled");
    if (options.isAlive && !options.isAlive()) {
      throw new ProviderUnavailableError("OpenCode 2.x server exited before it was ready", {
        cause: lastError,
      });
    }
    try {
      const info = await client.info(options.signal);
      if (info.version.startsWith("2.")) return info;
      lastError = new Error(`version ${info.version} is not 2.x`);
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw new ProviderUnavailableError("OpenCode 2.x server did not become ready", {
        cause: lastError,
      });
    }
    await Bun.sleep(options.intervalMs ?? 200);
  }
}
