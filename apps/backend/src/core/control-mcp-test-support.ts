import type { ControlMcpProfile } from "@orkestrator/protocol/control-mcp";
import { ControlMcpServer, readControlMcpDescriptor } from "./control-mcp-server.js";
import { setup } from "./public-api/test-provider.js";

/**
 * Control MCP over the real public-action stack: a real `StorageService`, the
 * real command registry and `public_action`, a real `NativeAgentService` with
 * a scripted provider (`public-api/test-provider.ts`), and the real loopback
 * listener on an ephemeral port. Nothing spends tokens.
 */

export type RpcResult = {
  tools?: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    annotations?: Record<string, boolean>;
  }>;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export type RpcBody = { result?: RpcResult; error?: { message?: string } };

export async function rpc(
  url: string,
  token: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ response: Response; body: RpcBody; bytes: number }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      ...(params ? { params } : {}),
    }),
  });
  const text = await response.text();
  const payload = response.headers.get("content-type")?.startsWith("text/event-stream")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length)
    : text;
  return {
    response,
    body: payload ? (JSON.parse(payload) as RpcBody) : {},
    bytes: payload ? Buffer.byteLength(payload) : 0,
  };
}

export async function controlMcpHarness() {
  const session = await setup();
  const server = new ControlMcpServer(
    session.harness.dataDir,
    async <T>(command: string, args: Record<string, unknown> = {}) => {
      const handler = session.harness.commands.get(command);
      if (!handler) throw new Error(`Unknown backend command: ${command}`);
      return (await handler(args, session.harness.context)) as T;
    },
    { port: 0 },
  );
  await server.start();
  const descriptor = await readControlMcpDescriptor(server.getInfo()!.descriptorFile);
  const url = descriptor.url;
  const credential = async (
    profile: ControlMcpProfile,
    options: { capabilities?: string[]; deniedActions?: string[]; label?: string } = {},
  ) => {
    const settings = await server.createCredential({
      label: options.label ?? `${profile} client`,
      profile,
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
      ...(options.deniedActions ? { deniedActions: options.deniedActions } : {}),
    });
    return settings.credentials.at(-1)!;
  };
  const call = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const { body } = await rpc(url, token, "tools/call", { name, arguments: args });
    if (body.error) throw new Error(`${name}: ${body.error.message}`);
    return body.result!;
  };
  const list = async (token: string) => {
    const { body, bytes } = await rpc(url, token, "tools/list");
    return { tools: body.result?.tools ?? [], bytes };
  };
  return {
    ...session,
    server,
    url,
    defaultToken: descriptor.token,
    credential,
    call,
    list,
    async close() {
      await server.stop();
    },
  };
}
