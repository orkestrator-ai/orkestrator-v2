/**
 * A 2.x server on the host OpenCode 2.x database, for work that has no
 * session: provider sign-in (`opencode-provider-login.ts`) and the host model
 * catalogue (`host-model-catalog-refresh.ts`).
 *
 * Every host 2.x server shares one database under `<data>/opencode2/`
 * (`openCode2HostPaths`), so:
 *
 * - **A running host 2.x server** is used as it is, unless the caller asks
 *   for a private one; a write through it reaches every one (2.x reads
 *   credentials from the database per use).
 * - **Otherwise a private server is started** from the managed binary with
 *   the same database and configuration, in Orkestrator's probe directory,
 *   used and stopped. It is owned like every short-lived probe, so backend
 *   shutdown stops it, and only this child is ever signalled. A database that
 *   does not exist yet is created by it, importing the user's `auth.json`
 *   once (2.x behaviour).
 *
 * Nothing here logs or returns a credential.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { mintBridgeToken } from "@orkestrator/protocol/node/bridge-credential";
import { resolveOpenCode2Binary } from "./commands-agent-support.js";
import type { CommandContext } from "./commands-context.js";
import { allocateLocalPort } from "./commands-servers.js";
import { OpenCode2Client } from "./opencode2/client.js";
import { runningOpenCode2HostClient } from "./opencode2/credentials.js";
import {
  openCode2HostLaunch,
  waitForOpenCode2Ready,
  writeOpenCode2HostConfig,
} from "./opencode2/server.js";
import { OPENCODE2_HOST_READY_TIMEOUT_MS } from "./opencode2-host-server.js";

const log = createLogger("native-agent.opencode2");

/** The working directory of every short-lived host probe and private server. */
export async function probeWorkingDirectory(context: CommandContext): Promise<string> {
  const directory = path.join(context.storage.getDataDir(), "model-catalog-probe");
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

export interface OpenCode2HostDatabaseServerOptions {
  /**
   * Always start a private server, even when a host one runs. For work that
   * outlives a request, such as an OAuth sign-in whose attempt (and callback
   * listener) lives in the server that started it: an environment's server
   * can be stopped or replaced at any time.
   */
  private?: boolean;
}

export type WithOpenCode2HostDatabaseServer = <T>(
  context: CommandContext,
  use: (client: OpenCode2Client) => Promise<T>,
  options?: OpenCode2HostDatabaseServerOptions,
) => Promise<T>;

/** A running host 2.x server, else a private one on the same database, for `use`. */
export async function withOpenCode2HostDatabaseServer<T>(
  context: CommandContext,
  use: (client: OpenCode2Client) => Promise<T>,
  options: OpenCode2HostDatabaseServerOptions = {},
): Promise<T> {
  const localServers = context.runtime.localServers;
  if (!options.private) {
    const running = runningOpenCode2HostClient(localServers);
    if (running) return use(running);
  }
  if (localServers.isShuttingDown()) {
    throw new Error("Backend is shutting down; OpenCode cannot be started");
  }
  const cliPath = resolveOpenCode2Binary(context);
  const dataDir = context.storage.getDataDir();
  const baseEnv = { ...process.env, ORKESTRATOR_PARENT_PID: String(process.pid) };
  const configDir = await writeOpenCode2HostConfig(dataDir, baseEnv);
  const directory = await probeWorkingDirectory(context);
  const port = await allocateLocalPort();
  const password = mintBridgeToken();
  const launch = openCode2HostLaunch({ cliPath, dataDir, configDir, port, password, baseEnv });
  const key = `opencode2-host-database:${randomUUID()}`;
  const release = await localServers.openCode2.startGate.acquire();
  let child: ReturnType<typeof localServers.spawn>;
  try {
    // Shutdown may have begun while this start waited behind another.
    if (localServers.isShuttingDown()) {
      throw new Error("Backend is shutting down; OpenCode cannot be started");
    }
    child = localServers.spawn(launch.command, launch.args, {
      cwd: directory,
      env: launch.env,
      detached: process.platform !== "win32",
    });
  } catch (error) {
    release();
    throw error;
  }
  localServers.adoptProcess(key, child);
  child.stdout.resume();
  child.stderr.resume();
  try {
    const client = new OpenCode2Client({
      baseUrl: `http://127.0.0.1:${port}`,
      password,
      directory,
    });
    try {
      await waitForOpenCode2Ready(client, {
        timeoutMs: OPENCODE2_HOST_READY_TIMEOUT_MS,
        isAlive: () => child.exitCode === null && child.signalCode === null,
      });
    } finally {
      release();
    }
    return await use(client);
  } finally {
    await localServers.terminate(key, child).catch((error: unknown) => {
      log.warn("host-database-server.exit-unclean", {
        error: formatLogError(error, { message: false }),
      });
    });
  }
}
