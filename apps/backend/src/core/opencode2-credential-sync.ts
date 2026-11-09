/**
 * Mirrors an Orkestrator OpenCode sign-in into the host OpenCode 2.x database
 * (owner decision 3 of 2026-11-09; the mapping is in `opencode2/credentials.ts`).
 *
 * `opencode-provider-login.ts` signs a provider in through 1.x, which writes
 * `auth.json`. Every host 2.x server shares one database under
 * `<data>/opencode2/` (`openCode2HostPaths`), which imported `auth.json` once
 * when it was created and never reads it again. After each 1.x change this
 * makes the 2.x database hold the same credential for that provider:
 *
 * - **No 2.x database yet: nothing to do.** Its first start imports
 *   `auth.json`, the change included.
 * - **A running host 2.x server** is used as it is; all of them share the
 *   database, so one write reaches every one (2.x reads credentials from the
 *   database per use).
 * - **Otherwise a private server is started** from the managed binary with
 *   the same database and configuration, in Orkestrator's probe directory,
 *   used for the write and stopped. It is owned like every short-lived probe,
 *   so backend shutdown stops it, and only this child is ever signalled.
 *
 * Nothing here logs or returns a credential.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { mintBridgeToken } from "@orkestrator/protocol/node/bridge-credential";
import { resolveOpenCode2Binary } from "./commands-agent-support.js";
import type { CommandContext } from "./commands-context.js";
import { allocateLocalPort } from "./commands-servers.js";
import { probeWorkingDirectory } from "./host-model-catalog-refresh.js";
import { OpenCode2Client } from "./opencode2/client.js";
import {
  legacyOpenCodeAuthFile,
  mirrorOpenCode2Credential,
  readLegacyOpenCodeCredential,
} from "./opencode2/credentials.js";
import { openCode2ServerKey } from "./opencode2/host-server-state.js";
import {
  openCode2HostLaunch,
  openCode2HostPaths,
  waitForOpenCode2Ready,
  writeOpenCode2HostConfig,
} from "./opencode2/server.js";
import { OPENCODE2_HOST_READY_TIMEOUT_MS } from "./opencode2-host-server.js";

const log = createLogger("native-agent.opencode2");

export type OpenCode2CredentialMirrorOutcome = "written" | "removed" | "unchanged" | "skipped";

export interface OpenCode2CredentialMirrorDependencies {
  /** The 1.x credential store; the host's own unless a test points elsewhere. */
  authFile?: string;
  /** Run `use` against a 2.x server on the host database (tests substitute it). */
  withServer?: <T>(
    context: CommandContext,
    use: (client: OpenCode2Client) => Promise<T>,
  ) => Promise<T>;
}

/** Make the host 2.x database hold what `auth.json` now holds for `providerId`. */
export async function mirrorOpenCodeLoginToOpenCode2(
  context: CommandContext,
  providerId: string,
  dependencies: OpenCode2CredentialMirrorDependencies = {},
): Promise<OpenCode2CredentialMirrorOutcome> {
  if (!existsSync(openCode2HostPaths(context.storage.getDataDir()).database)) return "skipped";
  const enabled = (await context.storage.loadConfig()).global.openCodeProtocol === "v2";
  const localServers = context.runtime.localServers;
  const running = Array.from(localServers.openCode2.live()).some(
    ([id, record]) => localServers.process(openCode2ServerKey(id)) === record.child,
  );
  if (!enabled && !running) return "skipped";
  const credential = await readLegacyOpenCodeCredential(
    dependencies.authFile ?? legacyOpenCodeAuthFile(),
    providerId,
  );
  const withServer = dependencies.withServer ?? withOpenCode2HostDatabaseServer;
  const outcome = await withServer(context, (client) =>
    mirrorOpenCode2Credential(client, providerId, credential),
  );
  log.info("credential.mirrored", { outcome });
  return outcome;
}

/** A running host 2.x server, else a private one on the same database for `use`. */
export async function withOpenCode2HostDatabaseServer<T>(
  context: CommandContext,
  use: (client: OpenCode2Client) => Promise<T>,
): Promise<T> {
  const localServers = context.runtime.localServers;
  for (const [environmentId, record] of localServers.openCode2.live()) {
    if (localServers.process(openCode2ServerKey(environmentId)) !== record.child) continue;
    return use(
      new OpenCode2Client({
        baseUrl: `http://127.0.0.1:${record.port}`,
        password: record.password,
        directory: record.directory,
      }),
    );
  }
  if (localServers.isShuttingDown()) {
    throw new Error("Backend is shutting down; OpenCode 2 cannot be updated");
  }
  const cliPath = resolveOpenCode2Binary(context);
  const dataDir = context.storage.getDataDir();
  const baseEnv = { ...process.env, ORKESTRATOR_PARENT_PID: String(process.pid) };
  const configDir = await writeOpenCode2HostConfig(dataDir, baseEnv);
  const directory = await probeWorkingDirectory(context);
  const port = await allocateLocalPort();
  const password = mintBridgeToken();
  const launch = openCode2HostLaunch({ cliPath, dataDir, configDir, port, password, baseEnv });
  const key = `opencode2-credential:${randomUUID()}`;
  const release = await localServers.openCode2.startGate.acquire();
  let child: ReturnType<typeof localServers.spawn>;
  try {
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
      log.warn("credential.server-exit-unclean", {
        error: formatLogError(error, { message: false }),
      });
    });
  }
}
