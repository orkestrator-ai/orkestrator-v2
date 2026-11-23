import { createServer, type Server } from "node:net";
import { networkInterfaces } from "node:os";
import { ENVIRONMENT_PORT_BLOCK_SIZE } from "./isolation.js";

/**
 * Wildcard binds alone can coexist with an existing address-specific listener
 * on macOS. Probe every local address too, without opening connections or
 * waiting on routes through VPN interfaces. At most one block is held at once.
 * This checks availability; the store lease reserves blocks between environments,
 * while unrelated host programs can still race to bind after the check.
 */
export async function environmentPortBlockAvailable(base: number): Promise<boolean> {
  const addresses = new Set(["0.0.0.0", "::", "127.0.0.1", "::1"]);
  for (const [name, interfaces] of Object.entries(networkInterfaces())) {
    for (const entry of interfaces ?? []) {
      const scope = entry.family === "IPv6" && entry.scopeid ? `%${name}` : "";
      addresses.add(`${entry.address}${scope}`);
    }
  }
  if (addresses.size > 64) return false;
  for (const host of addresses) {
    const servers: Server[] = [];
    try {
      const available = await Promise.all(
        Array.from(
          { length: ENVIRONMENT_PORT_BLOCK_SIZE },
          (_, offset) =>
            new Promise<boolean>((resolve) => {
              const server = createServer((socket) => socket.destroy());
              servers.push(server);
              server.once("error", (error: NodeJS.ErrnoException) => {
                // An interface can disappear during enumeration, and IPv6 may be disabled.
                resolve(error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL");
              });
              server.listen(
                {
                  host,
                  port: base + offset,
                  exclusive: true,
                  ipv6Only: host.includes(":"),
                  reusePort: false,
                },
                () => resolve(true),
              );
            }),
        ),
      );
      if (!available.every(Boolean)) return false;
    } finally {
      await Promise.all(
        servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
    }
  }
  return true;
}
