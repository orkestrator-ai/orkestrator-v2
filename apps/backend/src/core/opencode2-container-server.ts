/**
 * The OpenCode 2.x server inside a container environment
 * (docs/todo/agent-engines/0008-opencode-v2.md, build plan phase 3), and the
 * one entry point the native-agent service uses for either kind of
 * environment ({@link openCode2EnvironmentServer}).
 *
 * A second process beside the container's 1.x `opencode serve`, started only
 * when an OpenCode 2.x session needs it, on {@link OPENCODE2_SERVER_PORT}:
 *
 * - only in a container whose image lists `opencode2` and that publishes the
 *   port ({@link containerRunsOpenCode2}); an older image stays on 1.x;
 * - on an `opencode2-launch=1` image, started by the root-owned launcher from
 *   root's binary and configuration, with its listening socket recorded
 *   (`opencode2-container-launch.ts`), as 1.x is; on an older image, by
 *   `buildOpenCode2ContainerStartScript` from node's login shell. Either way
 *   the password goes on stdin to a root-only file (`opencode2-token`) and to
 *   the server alone, the credential plugin keeps it from the agent's tools,
 *   and an image that keeps no root credential is refused rather than weakened;
 * - ready once `/api/info` answers as 2.x, then warmed once in `/workspace`
 *   (`/api/agent`) so its plugins load before any tool can run;
 * - every request re-checks the listener after a refused connection or an
 *   answer the password does not open (`opencode-listener-recheck.ts`);
 * - reused while it answers with the persisted password and was started with
 *   the current plugins, and adopted after a backend restart (it outlives
 *   the backend, as every container server does).
 *
 * Observers (`start: false`) never start one. A container stop ends it; the
 * 1.x stop command leaves it alone. Starts share the container's OpenCode
 * bridge-operation queue, so they never race a 1.x start or login sync.
 */
import { createHash } from "node:crypto";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { mintBridgeToken } from "@orkestrator/protocol/node/bridge-credential";
import { ProviderUnavailableError } from "./agent-provider-contract.js";
import { syncContainerLoginUnlocked } from "./agent-accounts-containers.js";
import type { CommandContext } from "./commands-context.js";
import { dockerExec, getHostPort, isContainerRunning } from "./commands-container-exec.js";
import { isHttpServerReachable, waitForHttpServerExit } from "./commands-server-health.js";
import { OPENCODE2_SERVER_PORT } from "./constants.js";
import {
  containerBridgeOperationId,
  enqueueContainerBridgeOperation,
} from "./container-bridge-operations.js";
import {
  launchContainerScript,
  readContainerBridgeToken,
  readContainerOpenCodeCredential,
  recheckContainerOpenCodeListener,
  removeContainerBridgeCredential,
} from "./container-bridge-credential.js";
import {
  openCodeListenerRecheckFetch,
  type OpenCodeListenerRecheck,
} from "./opencode-listener-recheck.js";
import {
  containerOpenCode2Mode,
  type OpenCode2ContainerMode,
} from "./container-credential-mode.js";
import { currentRuntimeIdentity } from "./container-lifecycle-service.js";
import { boundDiagnosticTail, boundedTailCommand } from "./container-log-bounds.js";
import { networkOwnerContainer } from "./container-network-owner.js";
import { assertContainerNotDraining, ensureCurrentBootReady } from "./container-readiness.js";
import { readImageManifest } from "./docker-image.js";
import { retryableBridgeStartupError } from "./local-server-runtime.js";
import type { Environment } from "./models.js";
import { OpenCode2Client } from "./opencode2/client.js";
import {
  OPENCODE2_CONTAINER_DIRECTORY,
  OPENCODE2_CONTAINER_LOG,
  OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT,
  OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT_FILE,
  STOP_OPENCODE2_CONTAINER_SERVER_SCRIPT,
  buildOpenCode2ContainerStartScript,
  manifestRunsOpenCode2,
  publishesOpenCode2Port,
} from "./opencode2/container-server.js";
import type { OpenCode2RouteConnection } from "./opencode2/routing-provider.js";
import {
  OPENCODE2_LAUNCH_FINGERPRINT,
  recordOpenCode2Listener,
  startOpenCode2WithLauncher,
  stopOpenCode2Listeners,
} from "./opencode2-container-launch.js";
import { waitForOpenCode2Ready } from "./opencode2/server.js";
import { ensureOpenCode2HostServer, peekOpenCode2HostServer } from "./opencode2-host-server.js";
import { runCommand } from "./shell.js";

const log = createLogger("native-agent.opencode2");

/** The first start imports the container's credentials and migrates an empty database. */
export const OPENCODE2_CONTAINER_READY_TIMEOUT_MS = 75_000;
/** How long an observer trusts a known server before asking it again. */
const OBSERVED_VALIDITY_MS = 10_000;
/** How often an observer may look for a server this backend did not start. */
const ADOPT_RETRY_MS = 15_000;
const PROBE_TIMEOUT_MS = 3_000;

interface ContainerServerRecord {
  containerId: string;
  connection: OpenCode2RouteConnection;
  checkedAt: number;
}

interface ContainerServers {
  records: Map<string, ContainerServerRecord>;
  adoptAttempts: Map<string, number>;
}

/** Per backend runtime, so two backends in one process (tests) never share records. */
const runtimeServers = new WeakMap<object, ContainerServers>();

function serversOf(context: Pick<CommandContext, "runtime">): ContainerServers {
  let servers = runtimeServers.get(context.runtime);
  if (!servers) {
    servers = { records: new Map(), adoptAttempts: new Map() };
    runtimeServers.set(context.runtime, servers);
  }
  return servers;
}

/**
 * A new password is a new server, so the router rebuilds its 2.x provider.
 * Every request goes through the listener re-check
 * (`opencode-listener-recheck.ts`): after a refused connection or an answer
 * the password does not open, root is asked which socket listens on the port,
 * and once it is not the recorded one nothing more is sent on this connection.
 */
export function openCode2ContainerConnection(
  containerId: string,
  hostPort: number,
  password: string,
  recheck: OpenCodeListenerRecheck = () =>
    recheckContainerOpenCodeListener(containerId, "opencode2"),
): OpenCode2RouteConnection {
  const passwordTag = createHash("sha256").update(password).digest("hex").slice(0, 12);
  return {
    baseUrl: `http://127.0.0.1:${hostPort}`,
    password,
    directory: OPENCODE2_CONTAINER_DIRECTORY,
    generation: `container:${containerId}:${hostPort}:${passwordTag}`,
    fetch: openCodeListenerRecheckFetch(fetch, recheck, "opencode2").fetch,
  };
}

async function answersAs2x(connection: OpenCode2RouteConnection): Promise<boolean> {
  try {
    const info = await new OpenCode2Client(connection).info(AbortSignal.timeout(PROBE_TIMEOUT_MS));
    return info.version.startsWith("2.");
  } catch {
    return false;
  }
}

/**
 * Whether new OpenCode sessions in this container may run on 2.x: its image's
 * manifest lists a 2.x `opencode2`, and the container publishes the 2.x port
 * (one created before the port existed does not). Never assumed: an
 * unreadable image or container answers false.
 */
export async function containerRunsOpenCode2(
  context: Pick<CommandContext, "storage">,
  environment: Pick<Environment, "environmentType" | "containerId" | "containerLifecycle">,
  deps: {
    readManifest?: typeof readImageManifest;
    run?: typeof runCommand;
    networkOwner?: typeof networkOwnerContainer;
  } = {},
): Promise<boolean> {
  const containerId = environment.containerId?.trim();
  if (environment.environmentType !== "containerized" || !containerId) return false;
  const run = deps.run ?? runCommand;
  try {
    const imageId =
      currentRuntimeIdentity(environment as Environment, context)?.imageId ??
      (await run("docker", ["inspect", "--format", "{{.Image}}", containerId], {
        timeoutMs: 10_000,
      }).then(({ stdout }) => stdout.trim()));
    if (!imageId) return false;
    const read = await (deps.readManifest ?? readImageManifest)(imageId, context);
    if (read.kind !== "manifest" || !manifestRunsOpenCode2(read.manifest.agents)) return false;
    const owner = await (deps.networkOwner ?? networkOwnerContainer)(containerId);
    const { stdout } = await run(
      "docker",
      ["inspect", "--format", "{{json .HostConfig.PortBindings}}", owner],
      { timeoutMs: 10_000 },
    );
    return publishesOpenCode2Port(stdout);
  } catch {
    return false;
  }
}

/**
 * Load the workspace's instance, and with it the server's plugins: the
 * credential plugin's hardening (non-dumpable, password out of the
 * environment) is then in place before an agent's first tool call, and before
 * a launched server's socket is recorded. On 2.2.6 `/api/agent` loads them;
 * `/api/session/active` does not (probed 2026-11-10).
 */
async function warmContainerOpenCode2(
  client: OpenCode2Client,
  required = false,
  timeoutMs = 30_000,
): Promise<void> {
  await client
    .api("GET", "/api/agent", "OpenCode agents", { signal: AbortSignal.timeout(timeoutMs) })
    .catch((error: unknown) => {
      if (required) throw error;
      log.warn("container-server.warm-incomplete", {
        error: formatLogError(error, { message: false }),
      });
    });
}

/** Wait for a fresh server, with its log tail in the error when it never answers. */
async function waitForContainerOpenCode2(
  containerId: string,
  client: OpenCode2Client,
  password: string,
): Promise<void> {
  try {
    await waitForOpenCode2Ready(client, { timeoutMs: OPENCODE2_CONTAINER_READY_TIMEOUT_MS });
  } catch (error) {
    const tail = await dockerExec(
      containerId,
      boundedTailCommand(OPENCODE2_CONTAINER_LOG),
      undefined,
      [password],
    ).then(boundDiagnosticTail, () => "");
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderUnavailableError(`${message}${tail.trim() ? `\n${tail.trim()}` : ""}`, {
      cause: error,
    });
  }
}

/**
 * Start the container's 2.x server, or return the running one. Callers hold
 * the container's OpenCode bridge operation ({@link ensureOpenCode2ContainerServer}).
 *
 * On an `opencode2-launch=1` image (`opencode2-launcher`) the root-owned
 * launcher starts it from root's binary and configuration
 * (`opencode2-container-launch.ts`), its socket is recorded, and a server is
 * reused only while that socket is still the only listener.
 */
export async function startContainerOpenCode2Server(
  context: CommandContext,
  containerId: string,
  credentialMode: () => Promise<OpenCode2ContainerMode> = () =>
    containerOpenCode2Mode(context, containerId),
  warmTimeoutMs = 30_000,
): Promise<{ connection: OpenCode2RouteConnection; wasRunning: boolean }> {
  assertContainerNotDraining(containerId);
  if (!(await isContainerRunning(containerId))) {
    throw retryableBridgeStartupError("Container is not running");
  }
  const hostPort = await getHostPort(containerId, OPENCODE2_SERVER_PORT);
  if (!hostPort) {
    throw new ProviderUnavailableError(
      "This container was created without the OpenCode 2 port; rebuild it to use OpenCode 2",
    );
  }
  let resolvedMode: OpenCode2ContainerMode | undefined;
  const mode = async (): Promise<OpenCode2ContainerMode> =>
    (resolvedMode ??= await credentialMode());

  const persisted = await readContainerOpenCodeCredential(containerId, {}, "opencode2");
  // The password would go to whatever answers the port now: only the
  // recorded socket, on an image that records one, may receive it.
  const usable =
    persisted.token &&
    persisted.listener !== "replaced" &&
    !(persisted.requiresRecordedListener && persisted.listener !== "ours")
      ? persisted.token
      : null;
  if (usable) {
    const running = openCode2ContainerConnection(containerId, hostPort, usable);
    const launched = persisted.listener === "ours";
    if (
      (await answersAs2x(running)) &&
      (await startedWith(
        containerId,
        launched ? OPENCODE2_LAUNCH_FINGERPRINT : OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT,
      )) &&
      // A login-shell server is not reused once the image can launch one.
      (launched ||
        (await mode().then(
          (current) => current !== "opencode2-launcher",
          () => true,
        )))
    ) {
      return { connection: running, wasRunning: true };
    }
  }
  // A persisted password that no longer answers belongs to a stale process,
  // a server without one was not started by this backend, and a listener that
  // is not the recorded one is an imposter: replace any of them. Such a
  // listener may run under any name, so it is found by the socket it holds.
  const stopListeners = persisted.listener !== "unrecorded";
  if (persisted.token || stopListeners || (await isHttpServerReachable(hostPort, "/api/info"))) {
    if (stopListeners || (await mode()) === "opencode2-launcher") {
      await stopOpenCode2Listeners(containerId);
    }
    await dockerExec(containerId, STOP_OPENCODE2_CONTAINER_SERVER_SCRIPT);
    await removeContainerBridgeCredential(containerId, "opencode2").catch(() => undefined);
    await waitForHttpServerExit(hostPort).catch((error: unknown) => {
      if (!stopListeners) throw error;
      throw new ProviderUnavailableError(
        "Something other than OpenCode 2's server holds its port in this container and could not be stopped; restart the environment",
        { cause: error },
      );
    });
  }

  await ensureCurrentBootReady(containerId);
  const current = await mode();
  // Every image with `opencode2` keeps credentials in root's files; an image
  // that would leave the password where `node` reads it is refused.
  if (current === "token-file") {
    throw new ProviderUnavailableError(
      "This container's image cannot keep the OpenCode 2 password from its agent; rebuild it from a current image",
    );
  }
  if (current === "opencode2-launcher") {
    const password = await startOpenCode2WithLauncher(containerId);
    log.info("container-server.launched", {
      containerPort: OPENCODE2_SERVER_PORT,
      launcher: true,
    });
    const connection = openCode2ContainerConnection(containerId, hostPort, password);
    // No recorded socket exists yet. Startup probes must not trigger identity scans.
    const client = new OpenCode2Client({ ...connection, fetch });
    try {
      await waitForContainerOpenCode2(containerId, client, password);
      // Warmed first: loading the plugins makes the server non-dumpable, so
      // the socket recorded next cannot be taken out of it.
      await warmContainerOpenCode2(client, true, warmTimeoutMs);
      await recordOpenCode2Listener(containerId);
    } catch (error) {
      try {
        await stopOpenCode2Listeners(containerId);
      } finally {
        await removeContainerBridgeCredential(containerId, "opencode2");
      }
      throw error;
    }
    return { connection, wasRunning: false };
  }
  const password = mintBridgeToken();
  await launchContainerScript(containerId, buildOpenCode2ContainerStartScript(), {
    secrets: { OPENCODE_PASSWORD: password },
    rootCredential: { kind: "opencode2", token: password },
  });
  log.info("container-server.launched", { containerPort: OPENCODE2_SERVER_PORT });
  const connection = openCode2ContainerConnection(containerId, hostPort, password);
  const client = new OpenCode2Client(connection);
  await waitForContainerOpenCode2(containerId, client, password);
  await warmContainerOpenCode2(client);
  return { connection, wasRunning: false };
}

async function startedWith(containerId: string, expected: string): Promise<boolean> {
  const fingerprint = (
    await dockerExec(
      containerId,
      `cat ${OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT_FILE} 2>/dev/null || true`,
    ).catch(() => "")
  ).trim();
  return fingerprint === expected;
}

async function containerEnvironment(
  context: Pick<CommandContext, "storage">,
  environmentId: string,
): Promise<Environment & { containerId: string }> {
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment) throw new ProviderUnavailableError("The environment no longer exists");
  const containerId = environment.containerId?.trim();
  if (environment.environmentType !== "containerized" || !containerId) {
    throw new ProviderUnavailableError("The environment's container is not available");
  }
  return { ...environment, containerId };
}

/** The container environment's 2.x server, started when none is running. */
export async function ensureOpenCode2ContainerServer(
  context: CommandContext,
  environmentId: string,
): Promise<OpenCode2RouteConnection> {
  const environment = await containerEnvironment(context, environmentId);
  const { containerId } = environment;
  const servers = serversOf(context);
  if (environment.revokedInputProviders?.includes("opencode")) {
    throw new ProviderUnavailableError("OpenCode credentials are revoked for this environment");
  }
  if (context.runtime.localServers.isShuttingDown()) {
    throw new ProviderUnavailableError("Backend is shutting down; OpenCode 2 cannot start");
  }
  context.runtime.environments.fence.assertNotMoving(environmentId);
  if (!(await containerRunsOpenCode2(context, environment))) {
    throw new ProviderUnavailableError(
      "This container's image has no OpenCode 2; rebuild it from a current image to use OpenCode 2",
    );
  }
  const operationId = await containerBridgeOperationId(context, containerId);
  return enqueueContainerBridgeOperation(context, "opencode", operationId, async () => {
    // 2.x imports the login once, on its first start, so it is synced first.
    const current = await containerEnvironment(context, environmentId);
    if (current.revokedInputProviders?.includes("opencode"))
      throw new ProviderUnavailableError("OpenCode credentials are revoked for this environment");
    if ((await syncContainerLoginUnlocked(context, "opencode", containerId)) === "failed")
      throw new ProviderUnavailableError("OpenCode credential synchronization failed");
    const started = await startContainerOpenCode2Server(context, containerId);
    if ((await syncContainerLoginUnlocked(context, "opencode", containerId)) === "failed")
      throw new ProviderUnavailableError("OpenCode credential synchronization failed");
    servers.records.set(environmentId, {
      containerId,
      connection: started.connection,
      checkedAt: Date.now(),
    });
    if (!started.wasRunning) log.info("container-server.ready", { environmentId });
    return started.connection;
  });
}

/**
 * The running 2.x server's connection, never starting one. A server this
 * backend did not start (one from before a backend restart) is adopted
 * through its persisted password, at most every {@link ADOPT_RETRY_MS}.
 */
export async function peekOpenCode2ContainerServer(
  context: CommandContext,
  environmentId: string,
  now: () => number = Date.now,
): Promise<OpenCode2RouteConnection | undefined> {
  const environment = await context.storage.getEnvironment(environmentId).catch(() => null);
  const containerId = environment?.containerId?.trim();
  if (
    environment?.environmentType !== "containerized" ||
    !containerId ||
    environment.revokedInputProviders?.includes("opencode")
  )
    return undefined;
  const servers = serversOf(context);
  const known = servers.records.get(environmentId);
  if (known?.containerId === containerId) {
    if (now() - known.checkedAt < OBSERVED_VALIDITY_MS) return known.connection;
    if (await answersAs2x(known.connection)) {
      known.checkedAt = now();
      return known.connection;
    }
    // Gone with the container's last boot: no server, no turn in flight.
    servers.records.delete(environmentId);
    return undefined;
  }
  const lastAttempt = servers.adoptAttempts.get(environmentId);
  if (lastAttempt !== undefined && now() - lastAttempt < ADOPT_RETRY_MS) return undefined;
  servers.adoptAttempts.set(environmentId, now());
  try {
    const hostPort = await getHostPort(containerId, OPENCODE2_SERVER_PORT);
    if (!hostPort) return undefined;
    const password = await readContainerBridgeToken(containerId, "opencode2", {
      timeoutMs: 10_000,
    });
    if (!password) return undefined;
    const connection = openCode2ContainerConnection(containerId, hostPort, password);
    if (!(await answersAs2x(connection))) return undefined;
    servers.records.set(environmentId, { containerId, connection, checkedAt: now() });
    servers.adoptAttempts.delete(environmentId);
    return connection;
  } catch {
    return undefined;
  }
}

/**
 * The 2.x server of any environment: the host one for a local environment,
 * the in-container one for a container environment.
 */
export async function openCode2EnvironmentServer(
  context: CommandContext,
  environmentId: string,
  options: { start: boolean },
): Promise<OpenCode2RouteConnection | undefined> {
  const environment = await context.storage.getEnvironment(environmentId).catch(() => null);
  if (environment?.environmentType === "containerized") {
    return options.start
      ? ensureOpenCode2ContainerServer(context, environmentId)
      : peekOpenCode2ContainerServer(context, environmentId);
  }
  return options.start
    ? ensureOpenCode2HostServer(context, environmentId)
    : peekOpenCode2HostServer(context, environmentId);
}
