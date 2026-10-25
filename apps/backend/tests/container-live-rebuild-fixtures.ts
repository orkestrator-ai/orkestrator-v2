import { rmSync } from "node:fs";
import net from "node:net";
import type { CommandContext } from "../src/core/commands-context.js";
import { BackendRuntime } from "../src/core/backend-runtime.js";
import { EnvironmentLifecycleTaskTracker } from "../src/core/environment-lifecycle-tasks.js";
import type { RegistryWriter } from "../src/core/registry-writer-lease.js";
import { runCommand } from "../src/core/shell.js";
import type { StorageService } from "../src/core/storage.js";

/**
 * Fault-injection fixtures for container-live-rebuild-faults.test.ts. Nothing
 * here is reachable from production: the backend's Docker calls are pointed at
 * the proxy through the Docker CLI's own `DOCKER_HOST`, set only inside the
 * test process for the duration of one operation.
 */

export interface ProxiedRequest {
  connection: number;
  method: string;
  path: string;
  at: number;
}

export interface DockerApiProxy {
  /** `unix://` endpoint to hand the Docker CLI. */
  endpoint: string;
  requests: ProxiedRequest[];
  /** Bytes the daemon has sent back on each connection. */
  downstreamBytes: Map<number, number>;
  /**
   * Called for every chunk the daemon sends back, after it is counted. A
   * watcher may sever the proxy synchronously from here (mid-stream).
   */
  onDownstream: ((connection: number, request: ProxiedRequest | undefined) => void) | null;
  /**
   * The daemon "goes away": every open connection is destroyed and the
   * socket file is removed, so new connections fail as against a stopped
   * daemon whose socket disappeared.
   */
  sever(): void;
  /** The daemon is reachable again at the same endpoint. */
  restore(): Promise<void>;
  severed: boolean;
  close(): Promise<void>;
}

const REQUEST_LINE = /^(GET|HEAD|POST|PUT|DELETE) (\S+) HTTP\/1\.[01]\r?\n/;

/**
 * A byte-transparent unix-socket proxy in front of the real Docker API socket.
 * It only reads request lines (the first bytes of a chunk) so the test can
 * see which API call is in flight; payloads pass through untouched.
 */
export async function startDockerApiProxy(
  listenPath: string,
  upstreamPath: string,
): Promise<DockerApiProxy> {
  const sockets = new Set<net.Socket>();
  const lastRequest = new Map<number, ProxiedRequest>();
  let server: net.Server | null = null;
  let nextConnection = 1;

  const handle = (client: net.Socket) => {
    if (proxy.severed) {
      client.destroy();
      return;
    }
    const connection = nextConnection++;
    // Half-open both ways: the CLI half-closes a hijacked attach stream while
    // the daemon is still answering on it.
    const upstream = net.createConnection({ path: upstreamPath, allowHalfOpen: true });
    sockets.add(client);
    sockets.add(upstream);
    // `pipe` carries each side's end to the other; a closed side lets the
    // other flush and end, and only an error tears both down at once.
    const drop = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", drop);
    upstream.on("error", drop);
    client.on("close", () => {
      sockets.delete(client);
      upstream.end();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      client.end();
    });
    client.on("data", (chunk: Buffer) => {
      const head = REQUEST_LINE.exec(chunk.subarray(0, 512).toString("latin1"));
      if (head) {
        const request = { connection, method: head[1]!, path: head[2]!, at: Date.now() };
        proxy.requests.push(request);
        lastRequest.set(connection, request);
      }
    });
    upstream.on("data", (chunk: Buffer) => {
      proxy.downstreamBytes.set(
        connection,
        (proxy.downstreamBytes.get(connection) ?? 0) + chunk.length,
      );
      proxy.onDownstream?.(connection, lastRequest.get(connection));
    });
    client.pipe(upstream);
    upstream.pipe(client);
  };

  const listen = () =>
    new Promise<void>((resolve, reject) => {
      rmSync(listenPath, { force: true });
      const next = net.createServer({ allowHalfOpen: true }, handle);
      next.once("error", reject);
      next.listen(listenPath, () => {
        server = next;
        resolve();
      });
    });

  const proxy: DockerApiProxy = {
    endpoint: `unix://${listenPath}`,
    requests: [],
    downstreamBytes: new Map(),
    onDownstream: null,
    severed: false,
    sever() {
      if (proxy.severed) return;
      proxy.severed = true;
      server?.close();
      server = null;
      rmSync(listenPath, { force: true });
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
    async restore() {
      if (!proxy.severed) return;
      await listen();
      proxy.severed = false;
    },
    async close() {
      proxy.sever();
    },
  };
  await listen();
  return proxy;
}

/** The endpoint the real Docker CLI uses here, before any test override. */
export async function realDockerEndpoint(): Promise<string> {
  if (process.env.DOCKER_HOST) return process.env.DOCKER_HOST;
  const { stdout } = await runCommand(
    "docker",
    ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
    { timeoutMs: 30_000 },
  );
  return stdout.trim();
}

/**
 * Runs `body` with every Docker CLI call this process makes sent to
 * `endpoint`. Test-only: the CLI reads DOCKER_HOST itself; the backend has no
 * setting for it.
 */
export async function withDockerHost<T>(endpoint: string, body: () => Promise<T>): Promise<T> {
  const original = { host: process.env.DOCKER_HOST, context: process.env.DOCKER_CONTEXT };
  process.env.DOCKER_HOST = endpoint;
  // An explicit context would take precedence over DOCKER_HOST.
  delete process.env.DOCKER_CONTEXT;
  try {
    return await body();
  } finally {
    if (original.host === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = original.host;
    if (original.context !== undefined) process.env.DOCKER_CONTEXT = original.context;
  }
}

/** A Docker CLI call that always reaches the real daemon, bypassing the proxy. */
export async function realDocker(
  endpoint: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<string> {
  return (
    await runCommand("docker", args, {
      timeoutMs,
      env: { ...process.env, DOCKER_HOST: endpoint, DOCKER_CONTEXT: undefined },
    })
  ).stdout.trim();
}

export const QUALIFICATION_PROJECT = {
  id: "project-1",
  name: "Project",
  gitUrl: "https://example.invalid/none.git",
  localPath: null,
  addedAt: new Date(0).toISOString(),
  order: 0,
};

/**
 * The context a backend builds over a real data directory: the SQLite-backed
 * storage service and the registry writer lease, so every lifecycle write is
 * durable and another process can observe or reconcile it.
 */
export function durableLifecycleContext(
  storage: StorageService,
  writer: RegistryWriter,
  image: string,
  emit: (event: string, payload: unknown) => void = () => undefined,
): CommandContext {
  const context = {
    storage,
    emit: (event: string, payload: unknown) => emit(event, payload),
    appRoot: storage.getDataDir(),
    resourceRoot: storage.getDataDir(),
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    registryWriterLease: writer,
    dockerImage: image,
    runtimeFlavor: "agent-test",
    credentialSources: new Set(),
  } as unknown as CommandContext;
  Object.assign(context, {
    runtime: new BackendRuntime({ emit: (event, payload) => context.emit(event, payload) }),
  });
  return context;
}
