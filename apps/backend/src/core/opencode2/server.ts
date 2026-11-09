/**
 * How a host OpenCode 2.x server is launched (docs/todo/agent-engines/0008-opencode-v2.md,
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
 *   binary, and `OPENCODE_FLAGS` names every 2.2.6 feature flag explicitly.
 *   Scheduled tasks stay off, because they wake sessions with prompts
 *   Orkestrator never sent. A flag added by a later pin is off in releases
 *   unless named here.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { ProviderUnavailableError } from "../agent-provider-contract.js";
import type { OpenCode2Client } from "./client.js";
import type { OpenCode2Info } from "./types.js";
import { mirrorOpenCodeUserConfig } from "./user-config.js";

const log = createLogger("native-agent.opencode2");

export const OPENCODE2_CREDENTIAL_PLUGIN_ID = "orkestrator-credential";
/** Every 2.2.6 feature flag, on or off by name (`packages/schema/src/config/flag.ts`). */
export const OPENCODE2_FLAGS = "todo,-schedules,-background_compaction,-artifacts,-media_blob";

/**
 * A 2.x plugin needs only `{ id, setup }`; `Plugin.define` from
 * `@opencode/plugin` is a typed identity, so the source imports nothing and
 * no package has to be installed beside it. Verified on 2.2.6.
 *
 * `hardened: "refuse-tools"` is the container form. Deleting the variable
 * does not change `/proc/<pid>/environ`, which any process of the same uid
 * can read on Linux, so the plugin also marks the server non-dumpable, as the
 * 1.x plugin does (`buildOpenCodeCredentialPluginSource`), and refuses every
 * tool when it cannot. The host form only removes the variable: a host
 * promises no boundary between the agent and the user's own processes
 * (docs/architecture/agent-approvals.md).
 */
export function buildOpenCode2CredentialPluginSource(
  options: { hardened?: "refuse-tools" } = {},
): string {
  if (!options.hardened) {
    return `// Written by Orkestrator. Keeps the server password from this server's tools.
const NAMES = ["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"];

export default {
  id: ${JSON.stringify(OPENCODE2_CREDENTIAL_PLUGIN_ID)},
  async setup(ctx) {
    for (const name of NAMES) delete process.env[name];
    await ctx.shell.hook("create.before", (event) => {
      for (const name of NAMES) delete event.env[name];
    });
  },
};
`;
  }
  return `// Written by Orkestrator. Keeps the server password from this server's tools.
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
    }
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
