import { createSocket } from "node:dgram";
import { createServer, type AddressInfo } from "node:net";
import { DOCKER_LABEL_BACKEND_HOST_PORTS, DOCKER_LABEL_OWNER } from "./constants.js";

/**
 * Host ports the backend chooses itself for a rootless daemon's automatic
 * (`127.0.0.1::<port>`) mappings (to-do 7549 task 4).
 *
 * Rootless dockerd allocates an automatic host port inside RootlessKit's
 * namespace, in sequence from the bottom of that namespace's
 * `ip_local_port_range`, and cannot see host sockets. RootlessKit then binds
 * the port on the host and fails when a host socket holds it. The host's own
 * outbound loopback connections take their local ports from the same range,
 * so right after a daemon restart a whole run of the ports Docker draws next
 * can be held, and each failed start moves Docker on by one port only
 * (measured 2026-11-11): no retry count gets past a run longer than itself.
 *
 * Binding `127.0.0.1:0` on the host instead asks the host kernel, which sees
 * every socket, for a port nothing holds now, and Linux prefers odd ports for
 * `bind` where `connect` prefers even ones, so outbound churn rarely lands on
 * it later. The chosen ports are published as fixed ports and listed in the
 * {@link DOCKER_LABEL_BACKEND_HOST_PORTS} label, which tells the start path
 * they are not ports the user fixed.
 */

export type HostPortProtocol = "tcp" | "udp";

/** Holds one free loopback port of `protocol` open until `release`. */
export type HostPortProbe = (
  protocol: HostPortProtocol,
) => Promise<{ port: number; release: () => Promise<void> }>;

const AUTOMATIC_MAPPING = /^127\.0\.0\.1::(\d{1,5})\/(tcp|udp)$/;

/** Binds `127.0.0.1:0` and keeps it bound, so concurrent probes get distinct ports. */
export const probeLoopbackPort: HostPortProbe = (protocol) =>
  new Promise((resolve, reject) => {
    if (protocol === "udp") {
      const socket = createSocket("udp4");
      socket.once("error", reject);
      socket.bind(0, "127.0.0.1", () => {
        resolve({
          port: socket.address().port,
          release: () => new Promise<void>((done) => socket.close(() => done())),
        });
      });
      return;
    }
    const server = createServer();
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        release: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });

export interface BackendHostPorts {
  /** The `-p` arguments with every automatic loopback mapping given a host port. */
  publishArguments: string[];
  /** The ports the backend chose, in argument order. */
  chosen: number[];
}

export interface BackendHostPortOptions {
  probe?: HostPortProbe;
  /**
   * Host ports other containers already fix, refused for both protocols: a
   * stopped container's ports hold no host socket, so the probe alone would
   * hand them out again (the owner's labelled ports, {@link listOwnedBackendHostPorts}).
   */
  reserved?: Iterable<number>;
  /** Clock for the in-process reservations; tests pass their own. */
  now?: () => number;
}

/** A `-p` mapping that fixes its host port, any address: `[addr:]host:container[/proto]`. */
const FIXED_MAPPING = /^(?:.*:)?(\d{1,5}):\d{1,5}(?:\/(tcp|udp|sctp))?$/;

/** Probes per automatic mapping before giving up: refused candidates stay held. */
export const HOST_PORT_PROBE_ATTEMPTS = 32;

/**
 * How long a chosen port stays reserved in this process. It covers the window
 * between the choice and the labelled container existing, where neither the
 * kernel nor `docker ps` knows the port is taken, so two concurrent creates
 * cannot both receive it. Afterwards the owner's label is the record.
 */
export const HOST_PORT_RESERVATION_MS = 30 * 60_000;
const HOST_PORT_RESERVATION_LIMIT = 4_096;
const recentlyChosen = new Map<number, number>();

function activeReservations(now: number): Set<number> {
  for (const [port, expiry] of Array.from(recentlyChosen)) {
    if (expiry <= now) recentlyChosen.delete(port);
  }
  return new Set(recentlyChosen.keys());
}

function reserve(port: number, now: number): void {
  recentlyChosen.delete(port);
  recentlyChosen.set(port, now + HOST_PORT_RESERVATION_MS);
  // Bounded: the oldest reservation goes first (Map keeps insertion order).
  while (recentlyChosen.size > HOST_PORT_RESERVATION_LIMIT) {
    const oldest = recentlyChosen.keys().next().value;
    if (oldest === undefined) break;
    recentlyChosen.delete(oldest);
  }
}

/** Forgets every in-process reservation; for tests. */
export function resetBackendHostPortReservations(): void {
  recentlyChosen.clear();
}

/**
 * Gives every automatic loopback mapping in `publishArguments` a host port
 * the host kernel reports free and nothing else claims: not a port this
 * request fixes (Docker has not bound it yet), not one in `reserved`, and not
 * one this process chose recently. A refused candidate stays bound until the
 * end, so the next probe cannot return it again. All probes stay bound until
 * every port is chosen, so the ports are distinct; they are released before
 * Docker binds them. Fixed mappings and other arguments are kept as they are.
 */
export async function chooseBackendHostPorts(
  publishArguments: readonly string[],
  options: BackendHostPortOptions = {},
): Promise<BackendHostPorts> {
  const probe = options.probe ?? probeLoopbackPort;
  const now = (options.now ?? Date.now)();
  const result = [...publishArguments];
  const refusedAny = activeReservations(now);
  for (const port of options.reserved ?? []) refusedAny.add(port);
  const fixed = new Set<string>();
  for (let index = 0; index < result.length; index += 1) {
    if (result[index] !== "-p") continue;
    const match = FIXED_MAPPING.exec(result[index + 1] ?? "");
    if (match) fixed.add(`${match[2] ?? "tcp"}/${match[1]}`);
  }
  const chosen: number[] = [];
  const held: Array<() => Promise<void>> = [];
  try {
    for (let index = 0; index < result.length; index += 1) {
      if (result[index] !== "-p") continue;
      const match = AUTOMATIC_MAPPING.exec(result[index + 1] ?? "");
      if (!match) continue;
      const protocol = match[2] as HostPortProtocol;
      let port: number | null = null;
      for (let attempt = 0; attempt < HOST_PORT_PROBE_ATTEMPTS && port === null; attempt += 1) {
        const candidate = await probe(protocol);
        held.push(candidate.release);
        if (refusedAny.has(candidate.port) || fixed.has(`${protocol}/${candidate.port}`)) continue;
        port = candidate.port;
      }
      if (port === null) {
        throw new Error(
          `No free ${protocol} host port was found for a published port after ${HOST_PORT_PROBE_ATTEMPTS} tries.`,
        );
      }
      chosen.push(port);
      result[index + 1] = `127.0.0.1:${port}:${match[1]}/${match[2]}`;
    }
    for (const port of chosen) reserve(port, now);
  } finally {
    await Promise.all(held.map((release) => release().catch(() => undefined)));
  }
  return { publishArguments: result, chosen };
}

/**
 * The backend-chosen host ports labelled on every container of `owner`,
 * running or stopped. A failed listing is returned as an error for the
 * caller to report; it never claims that no port is taken.
 */
export async function listOwnedBackendHostPorts(
  owner: string,
  run: (
    command: string,
    args: string[],
    options: { timeoutMs: number },
  ) => Promise<{ stdout: string }>,
): Promise<number[]> {
  const { stdout } = await run(
    "docker",
    [
      "ps",
      "-a",
      "--filter",
      `label=${DOCKER_LABEL_OWNER}=${owner}`,
      "--filter",
      `label=${DOCKER_LABEL_BACKEND_HOST_PORTS}`,
      "--format",
      `{{.Label "${DOCKER_LABEL_BACKEND_HOST_PORTS}"}}`,
    ],
    { timeoutMs: 15_000 },
  );
  const ports = new Set<number>();
  for (const line of stdout.split("\n")) {
    for (const port of parseBackendHostPortsLabel(line)) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/** `--label` arguments recording the backend-chosen ports; none when there are none. */
export function backendHostPortLabelArguments(chosen: readonly number[]): string[] {
  return chosen.length > 0
    ? ["--label", `${DOCKER_LABEL_BACKEND_HOST_PORTS}=${chosen.join(",")}`]
    : [];
}

/** Parses the label's value; an absent or malformed label names no port. */
export function parseBackendHostPortsLabel(value: string | undefined): number[] {
  const text = (value ?? "").trim();
  if (!text || text === "<no value>") return [];
  const ports: number[] = [];
  for (const part of text.split(",")) {
    if (!/^\d{1,5}$/.test(part)) return [];
    const port = Number.parseInt(part, 10);
    if (port < 1 || port > 65_535) return [];
    ports.push(port);
  }
  return ports;
}
