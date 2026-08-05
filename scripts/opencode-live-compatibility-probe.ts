/**
 * Live OpenCode CLI + v2 SDK compatibility probe.
 *
 * This is a Bun/Node-only script: it opens sockets, spawns processes and writes
 * to a temp directory, so it must never be imported by app code (that would pull
 * `node:net`/`node:fs` into the renderer bundle). Test files may import it — they
 * are not bundled — and every external effect is behind an injected seam so the
 * error paths can be covered without a real CLI or network.
 */
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "../apps/web/src/lib/opencode-client";

/**
 * Marks the single stdout line that carries the result. Anything else in this
 * process may also write to stdout (Bun routes `console.debug` there, and
 * `opencode-client` has one), so the caller cannot parse the whole stream.
 */
export const RESULT_SENTINEL = "__OPENCODE_COMPAT_RESULT__";

const HEALTH_ATTEMPTS = 100;
const HEALTH_POLL_INTERVAL_MS = 100;
const HEALTH_REQUEST_TIMEOUT_MS = 2_000;
const SESSION_LIST_TIMEOUT_MS = 10_000;
const SERVER_EXIT_TIMEOUT_MS = 2_000;
/** Comfortably under the live test's 30s timeout, so the probe fails first. */
const PROBE_DEADLINE_MS = 25_000;

export interface OpenCodeHealthPayload {
  healthy?: unknown;
  version?: unknown;
  [key: string]: unknown;
}

export interface OpenCodeLiveCompatibilityResult {
  cliVersion: string;
  /** The whole payload, so the caller can assert its exact shape. */
  health: OpenCodeHealthPayload;
  /** The version actually installed, so the caller can cross-check the pin. */
  sdkVersion: string;
  sessionCount: number;
}

export interface CliInvocation {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type RunCli = (command: string[]) => Promise<CliInvocation>;

/** The subset of `Bun.spawn`'s handle this probe depends on. */
export interface ServerHandle {
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

export type SpawnServer = (
  command: string[],
  options: { cwd: string; env: Record<string, string | undefined> },
) => ServerHandle;

export type ProbeFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type Sleep = (milliseconds: number) => Promise<void>;

export interface SessionListResult {
  data?: unknown;
  error?: unknown;
}

export type ListSessions = (
  baseUrl: string,
  directory: string,
  signal: AbortSignal,
) => Promise<SessionListResult>;

export interface OpenCodeLiveCompatibilityOptions {
  cliPath?: string;
  /** Defaults to the `@opencode-ai/sdk` pin in `apps/web/package.json`. */
  expectedVersion?: string;
  /** Defaults to the version of the installed `@opencode-ai/sdk` package. */
  installedSdkVersion?: string;
  runCli?: RunCli;
  spawnServer?: SpawnServer;
  listSessions?: ListSessions;
  fetchImpl?: ProbeFetch;
  sleep?: Sleep;
  allocatePort?: () => Promise<number>;
  healthAttempts?: number;
  deadlineMs?: number;
}

const defaultSleep: Sleep = (milliseconds) => Bun.sleep(milliseconds);

const defaultRunCli: RunCli = async (command) => {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
};

const defaultSpawnServer: SpawnServer = (command, options) =>
  Bun.spawn(command, { ...options, stdout: "ignore", stderr: "ignore" });

const defaultListSessions: ListSessions = async (baseUrl, directory, signal) => {
  const client = createClient(baseUrl, directory);
  return await client.session.list(undefined, { signal });
};

function createTimer(milliseconds: number): { expired: Promise<void>; cancel: () => void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, milliseconds);
  });
  return { expired, cancel: () => clearTimeout(handle) };
}

/** Resolves `false` when `work` has not settled in time. Always clears its timer. */
async function settledWithin(work: Promise<unknown>, milliseconds: number): Promise<boolean> {
  const timer = createTimer(milliseconds);
  try {
    return await Promise.race([work.then(() => true), timer.expired.then(() => false)]);
  } finally {
    timer.cancel();
  }
}

/** Wraps `work` so repeated calls share one run — teardown has two callers. */
function once(work: () => Promise<void>): () => Promise<void> {
  let started: Promise<void> | undefined;
  return () => (started ??= work());
}

/**
 * Teardown for the probe currently in flight, so a signal handler or the overall
 * deadline can reach the spawned server and its temp root.
 */
let activeProbeTeardown: (() => Promise<void>) | null = null;

export async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (port <= 0) throw new Error("Could not allocate a loopback port");
  return port;
}

/** Reads the exact `@opencode-ai/sdk` version `apps/web` pins. */
export async function readPinnedSdkVersion(): Promise<string> {
  const webManifest = JSON.parse(
    await readFile(join(import.meta.dir, "..", "apps", "web", "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const pinned = webManifest.dependencies?.["@opencode-ai/sdk"];
  if (!pinned?.match(/^\d+\.\d+\.\d+$/)) {
    throw new Error("apps/web must exactly pin @opencode-ai/sdk");
  }
  return pinned;
}

/**
 * Reads the version of the `@opencode-ai/sdk` that is actually installed, so the
 * caller's comparison against the pin is a real check rather than a tautology.
 *
 * Resolution starts from the web workspace that owns the dependency, not the
 * caller's cwd. The package does not export `./package.json`, so this walks up
 * from the resolved entry point instead of resolving the manifest directly.
 */
export async function readInstalledSdkVersion(): Promise<string> {
  const webPackageRoot = join(import.meta.dir, "..", "apps", "web");
  const entry = Bun.resolveSync("@opencode-ai/sdk/v2/client", webPackageRoot);
  let directory = dirname(entry);
  for (;;) {
    const manifestPath = join(directory, "package.json");
    const manifest = await readFile(manifestPath, "utf8").then(
      (contents) => JSON.parse(contents) as { name?: string; version?: string },
      () => null,
    );
    if (manifest?.name === "@opencode-ai/sdk" && manifest.version) return manifest.version;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Could not resolve the installed @opencode-ai/sdk version from ${entry}`);
}

/**
 * `opencode --version` prints a bare semver today, but CLIs grow update notices
 * on later lines; taking the last whitespace-delimited token of the whole output
 * would silently start comparing against the *advertised* version.
 */
export function parseCliVersion(versionOutput: string): string {
  const firstLine = versionOutput.split("\n").find((line) => line.trim().length > 0) ?? "";
  return firstLine.trim().match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0] ?? "";
}

export async function readCliVersion(cliPath: string, runCli: RunCli): Promise<string> {
  const { stdout, stderr, exitCode } = await runCli([cliPath, "--version"]);
  if (exitCode !== 0) {
    throw new Error(`Could not execute ${cliPath}: ${stderr.trim()}`);
  }
  return parseCliVersion(stdout);
}

export async function waitForHealth(
  baseUrl: string,
  processHandle: Pick<ServerHandle, "exitCode">,
  options: {
    fetchImpl?: ProbeFetch;
    sleep?: Sleep;
    attempts?: number;
    intervalMs?: number;
    requestTimeoutMs?: number;
  } = {},
): Promise<OpenCodeHealthPayload> {
  const {
    fetchImpl = fetch,
    sleep = defaultSleep,
    attempts = HEALTH_ATTEMPTS,
    intervalMs = HEALTH_POLL_INTERVAL_MS,
    requestTimeoutMs = HEALTH_REQUEST_TIMEOUT_MS,
  } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (processHandle.exitCode !== null) {
      throw new Error(`OpenCode exited before becoming healthy (${processHandle.exitCode})`);
    }
    try {
      // A server that accepts the connection and then never answers would hang
      // the whole probe, so every attempt is individually bounded.
      const response = await fetchImpl(`${baseUrl}/global/health`, {
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (response.ok) {
        return (await response.json()) as OpenCodeHealthPayload;
      }
      lastError = new Error(`health returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error("OpenCode did not become healthy", { cause: lastError });
}

export function assertHealthy(health: OpenCodeHealthPayload, expectedVersion: string): void {
  if (health.healthy !== true || health.version !== expectedVersion) {
    throw new Error(
      `OpenCode health reported ${JSON.stringify(health)}, expected version ${expectedVersion}`,
    );
  }
}

/** Returns the session count, asserting the isolated server really is empty. */
export function readEmptySessionCount(sessions: SessionListResult): number {
  if (sessions.error !== undefined) {
    throw new Error("OpenCode SDK session.list returned an error");
  }
  if (!Array.isArray(sessions.data)) {
    throw new Error("OpenCode SDK session.list did not return an array");
  }
  if (sessions.data.length !== 0) {
    throw new Error(`Isolated OpenCode server returned ${sessions.data.length} sessions`);
  }
  return sessions.data.length;
}

/** SIGTERM alone can be ignored, so a stuck server is escalated to SIGKILL. */
export async function stopServer(
  server: ServerHandle,
  exitTimeoutMs = SERVER_EXIT_TIMEOUT_MS,
): Promise<void> {
  if (server.exitCode !== null) return;
  server.kill();
  if (await settledWithin(server.exited, exitTimeoutMs)) return;
  server.kill("SIGKILL");
  await settledWithin(server.exited, exitTimeoutMs);
}

async function probeOpenCode(
  options: OpenCodeLiveCompatibilityOptions,
): Promise<OpenCodeLiveCompatibilityResult> {
  const {
    runCli = defaultRunCli,
    spawnServer = defaultSpawnServer,
    listSessions = defaultListSessions,
    fetchImpl = fetch,
    sleep = defaultSleep,
    allocatePort = availableLoopbackPort,
    healthAttempts = HEALTH_ATTEMPTS,
  } = options;

  const expectedVersion = options.expectedVersion ?? (await readPinnedSdkVersion());
  const sdkVersion = options.installedSdkVersion ?? (await readInstalledSdkVersion());
  const cliPath = options.cliPath ?? (process.env.OPENCODE_CLI_PATH?.trim() || "opencode");
  const cliVersion = await readCliVersion(cliPath, runCli);
  if (cliVersion !== expectedVersion) {
    throw new Error(
      `${cliPath} reports ${cliVersion || "an unknown version"}, but `
      + `@opencode-ai/sdk pins ${expectedVersion}`,
    );
  }

  const isolatedRoot = await mkdtemp(join(tmpdir(), "ork-opencode-compat-"));
  let server: ServerHandle | undefined;
  const teardown = once(async () => {
    if (server) await stopServer(server);
    await rm(isolatedRoot, { recursive: true, force: true });
  });
  activeProbeTeardown = teardown;

  try {
    const configRoot = join(isolatedRoot, "config");
    const dataRoot = join(isolatedRoot, "data");
    const stateRoot = join(isolatedRoot, "state");
    const cacheRoot = join(isolatedRoot, "cache");
    await Promise.all(
      [configRoot, dataRoot, stateRoot, cacheRoot].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    );
    const port = await allocatePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    server = spawnServer(
      [cliPath, "serve", "--hostname", "127.0.0.1", "--port", String(port)],
      {
        cwd: isolatedRoot,
        env: {
          ...process.env,
          XDG_CONFIG_HOME: configRoot,
          XDG_DATA_HOME: dataRoot,
          XDG_STATE_HOME: stateRoot,
          XDG_CACHE_HOME: cacheRoot,
        },
      },
    );

    const health = await waitForHealth(baseUrl, server, {
      fetchImpl,
      sleep,
      attempts: healthAttempts,
    });
    assertHealthy(health, expectedVersion);

    const sessions = await listSessions(
      baseUrl,
      isolatedRoot,
      AbortSignal.timeout(SESSION_LIST_TIMEOUT_MS),
    );

    return {
      cliVersion,
      health,
      sdkVersion,
      sessionCount: readEmptySessionCount(sessions),
    };
  } finally {
    activeProbeTeardown = null;
    await teardown();
  }
}

export async function runOpenCodeLiveCompatibility(
  options: OpenCodeLiveCompatibilityOptions = {},
): Promise<OpenCodeLiveCompatibilityResult> {
  const deadlineMs = options.deadlineMs ?? PROBE_DEADLINE_MS;
  const deadline = createTimer(deadlineMs);
  try {
    return await Promise.race([
      probeOpenCode(options),
      // The abandoned probe cannot run its own `finally` before this rejects, so
      // the deadline branch tears the server down itself.
      deadline.expired.then<never>(async () => {
        await activeProbeTeardown?.();
        throw new Error(`OpenCode compatibility probe exceeded ${deadlineMs}ms`);
      }),
    ]);
  } finally {
    deadline.cancel();
  }
}

/**
 * The live test spawns this probe as a child, which makes `opencode serve` a
 * *grandchild* that Bun's dangling-process reaper cannot see. On a test timeout
 * or Ctrl-C only this process is signalled, so it has to tear the server and its
 * temp root down itself before exiting, or the server outlives the run holding a
 * port and a temp directory forever.
 */
export interface ProbeTerminationRuntime {
  on(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  exit(code: number): unknown;
}

export function installProbeTerminationHandlers(
  runtime: ProbeTerminationRuntime = process,
  getActiveTeardown: () => (() => Promise<void>) | null = () => activeProbeTeardown,
): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    runtime.on(signal, () => {
      const teardown = getActiveTeardown();
      if (!teardown) {
        runtime.exit(1);
        return;
      }
      void teardown().catch(() => {}).finally(() => runtime.exit(1));
    });
  }
}

if (import.meta.main) {
  installProbeTerminationHandlers();
  try {
    console.log(`${RESULT_SENTINEL}${JSON.stringify(await runOpenCodeLiveCompatibility())}`);
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  }
}
