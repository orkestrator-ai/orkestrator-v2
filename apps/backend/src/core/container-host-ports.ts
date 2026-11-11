import { createSocket } from "node:dgram";
import { createServer, type AddressInfo } from "node:net";
import { DOCKER_LABEL_BACKEND_HOST_PORTS } from "./constants.js";

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

/**
 * Gives every automatic loopback mapping in `publishArguments` a host port
 * the host kernel reports free. All probes stay bound until every port is
 * chosen, so the ports are distinct; they are released before Docker binds
 * them. Fixed mappings and other arguments are kept as they are.
 */
export async function chooseBackendHostPorts(
  publishArguments: readonly string[],
  probe: HostPortProbe = probeLoopbackPort,
): Promise<BackendHostPorts> {
  const result = [...publishArguments];
  const chosen: number[] = [];
  const held: Array<() => Promise<void>> = [];
  try {
    for (let index = 0; index < result.length; index += 1) {
      if (result[index] !== "-p") continue;
      const match = AUTOMATIC_MAPPING.exec(result[index + 1] ?? "");
      if (!match) continue;
      const { port, release } = await probe(match[2] as HostPortProtocol);
      held.push(release);
      chosen.push(port);
      result[index + 1] = `127.0.0.1:${port}:${match[1]}/${match[2]}`;
    }
  } finally {
    await Promise.all(held.map((release) => release().catch(() => undefined)));
  }
  return { publishArguments: result, chosen };
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
