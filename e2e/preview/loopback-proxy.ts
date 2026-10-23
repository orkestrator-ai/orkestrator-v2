import { createServer, request as httpRequest } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";

/** Resolve only the harness's test hosts; preserve browser URLs, TLS and headers. */
export async function startLoopbackProxy(options: {
  domain: string;
  port: number;
  redirectPort: number;
  gateway: string;
}): Promise<{ server: string; close(): Promise<void> }> {
  const gateway = new URL(options.gateway);
  const sockets = new Set<Socket>();
  const proxy = createServer((request, response) => {
    // The hostile-worker test also visits the real loopback control gateway.
    const url = new URL(request.url ?? "/", options.gateway);
    if (url.origin !== gateway.origin) {
      response.writeHead(403).end();
      return;
    }
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: gateway.port,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers: request.headers,
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );
    upstream.on("error", () => response.destroy());
    request.on("error", () => upstream.destroy());
    request.pipe(upstream);
  });
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  proxy.on("connect", (request, client, head) => {
    const target = new URL(`https://${request.url}`);
    const port = Number(target.port || 443);
    const allowed =
      (target.hostname.endsWith(`.${options.domain}`) && port === options.port) ||
      (target.hostname === "idp.identity.test" && port === options.redirectPort);
    if (!allowed) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = connect(port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  return {
    server: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    async close() {
      for (const socket of Array.from(sockets)) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
