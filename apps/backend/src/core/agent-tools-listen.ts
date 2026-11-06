import { createServer, type Server } from "node:http";

/** The address host agents are handed (`http://127.0.0.1:<port>/mcp`). */
export const AGENT_TOOLS_LOOPBACK_HOST = "127.0.0.1";

/** Bind addresses whose listener also accepts connections to 127.0.0.1. */
const WILDCARD_BIND_ADDRESSES = new Set(["", "0.0.0.0", "::", "0:0:0:0:0:0:0:0"]);

/** Ephemeral ports tried after the preferred one before giving up. */
const EPHEMERAL_ATTEMPTS = 3;

export type BindListener = (server: Server, port: number, host: string) => Promise<void>;

export interface AgentToolsListenOptions {
  /** Creates one listener with every handler (dispatch and peer gate) attached. */
  create: () => Server;
  bindAddress: string;
  /** The port to ask for first; 0 lets the OS choose. */
  preferredPort: number;
  /**
   * An explicit port is an exact constraint: never fall back to another port
   * (isolated evidence must not land on an OS-selected reserved port).
   */
  exact: boolean;
  /** Test seam for the platform's bind rules; defaults to `server.listen`. */
  bind?: BindListener;
  /** Told when a port is given up because another process owns its loopback address. */
  onLoopbackTaken?: (port: number) => void;
}

export interface AgentToolsListeners {
  port: number;
  /** The bind-address listener, then the loopback listener when one was needed. */
  servers: Server[];
}

/** The port is unusable for host agents because another process owns `127.0.0.1:<port>`. */
export class AgentToolsLoopbackTakenError extends Error {
  readonly code = "EADDRINUSE";
  constructor(readonly port: number) {
    super(
      `Agent tools port ${port} is held on ${AGENT_TOOLS_LOOPBACK_HOST} by another process; host agents would reach it instead of this backend`,
    );
    this.name = "AgentToolsLoopbackTakenError";
  }
}

export const bindListener: BindListener = (server, port, host) =>
  new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

function closeListener(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

export async function closeListeners(servers: readonly Server[]): Promise<void> {
  await Promise.all(servers.map(closeListener));
}

function boundPort(server: Server): number | null {
  const address = server.address();
  return address && typeof address !== "string" ? address.port : null;
}

/**
 * Whether this OS lets one process listen on `127.0.0.1:<port>` beside its own
 * wildcard listener on the same port, measured once on an ephemeral port.
 *
 * macOS (BSD rules) allows it, and allows it across processes too, which is
 * the defect this module exists for. Linux refuses it, and refuses it across
 * processes equally, so there a successful wildcard bind already proves no
 * other listener holds the loopback address, and none can take it later.
 */
export async function loopbackOverlapsWildcard(
  bind: BindListener = bindListener,
  wildcardHost = "0.0.0.0",
): Promise<boolean> {
  const wildcard = createServer();
  const loopback = createServer();
  try {
    await bind(wildcard, 0, wildcardHost);
    const port = boundPort(wildcard);
    if (port === null) throw new Error("Agent tools overlap check did not receive a TCP port");
    try {
      await bind(loopback, port, AGENT_TOOLS_LOOPBACK_HOST);
      return true;
    } catch (error) {
      if ((error as { code?: unknown }).code === "EADDRINUSE") return false;
      throw error;
    }
  } finally {
    await closeListeners([loopback, wildcard]);
  }
}

/** The measured rule per wildcard host; it is a property of the OS, so it never changes. */
const measuredOverlap = new Map<string, Promise<boolean>>();

function overlapRule(bind: BindListener | undefined, wildcardHost: string): Promise<boolean> {
  if (bind) return loopbackOverlapsWildcard(bind, wildcardHost);
  let measured = measuredOverlap.get(wildcardHost);
  if (!measured) {
    measured = loopbackOverlapsWildcard(bindListener, wildcardHost).catch((error: unknown) => {
      measuredOverlap.delete(wildcardHost);
      throw error;
    });
    measuredOverlap.set(wildcardHost, measured);
  }
  return measured;
}

/**
 * Listens for the agent tools server so that host agents' `127.0.0.1:<port>`
 * always reaches this process.
 *
 * A wildcard bind alone is not enough on macOS: BSD socket rules let it
 * succeed beside another process's `127.0.0.1:<port>` listener, and the kernel
 * then hands every loopback connection (and the bearer token in it) to the
 * more specific bind. So after a wildcard bind this also binds
 * `127.0.0.1:<port>` itself, which both proves the address free and stops a
 * later process from taking it. Where that second bind is refused, the OS's
 * overlap rule decides: an OS that refuses the overlap within one process
 * (Linux) refuses it between processes too, so the wildcard listener alone
 * owns loopback; an OS that allows it means another process holds the
 * address. A port whose loopback belongs to someone else is released and an
 * ephemeral one tried instead, unless the port is exact. Nothing is ever sent
 * to the other process.
 */
export async function listenAgentTools(
  options: AgentToolsListenOptions,
): Promise<AgentToolsListeners> {
  const bind = options.bind ?? bindListener;
  const coversLoopback = WILDCARD_BIND_ADDRESSES.has(options.bindAddress);
  const candidates = options.exact
    ? [options.preferredPort]
    : options.preferredPort === 0
      ? Array.from({ length: EPHEMERAL_ATTEMPTS }, () => 0)
      : [options.preferredPort, ...Array.from({ length: EPHEMERAL_ATTEMPTS }, () => 0)];
  let lastTaken: AgentToolsLoopbackTakenError | null = null;

  for (const candidate of candidates) {
    const primary = options.create();
    try {
      await bind(primary, candidate, options.bindAddress);
    } catch (error) {
      if (options.exact || candidate === 0 || (error as { code?: unknown }).code !== "EADDRINUSE")
        throw error;
      continue;
    }
    const port = boundPort(primary);
    if (port === null) {
      await closeListener(primary);
      throw new Error("Agent tools server did not receive a TCP port");
    }
    if (!coversLoopback) return { port, servers: [primary] };

    const loopback = options.create();
    try {
      await bind(loopback, port, AGENT_TOOLS_LOOPBACK_HOST);
      return { port, servers: [primary, loopback] };
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EADDRINUSE") {
        await closeListener(primary);
        throw error;
      }
    }
    let overlaps: boolean;
    try {
      overlaps = await overlapRule(options.bind, options.bindAddress);
    } catch (error) {
      await closeListener(primary);
      throw error;
    }
    if (!overlaps) return { port, servers: [primary] };
    await closeListener(primary);
    lastTaken = new AgentToolsLoopbackTakenError(port);
    options.onLoopbackTaken?.(port);
    if (options.exact) throw lastTaken;
  }
  throw lastTaken ?? new Error("Agent tools server could not bind a port");
}
