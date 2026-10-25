/** A stateless MCP server over plain JSON: just enough for OpenCode to list tools. */
export function fixtureMcpServer(tools: string[]) {
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      requests += 1;
      const message = (await request.json()) as { id?: number; method: string };
      if (message.id === undefined) return new Response(null, { status: 202 });
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1.0.0" },
            }
          : message.method === "tools/list"
            ? {
                tools: tools.map((name) => ({
                  name,
                  description: `fixture ${name}`,
                  inputSchema: { type: "object", properties: {} },
                })),
              }
            : {};
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    },
  });
  return { url: server.url, requests: () => requests, stop: () => server.stop(true) };
}
