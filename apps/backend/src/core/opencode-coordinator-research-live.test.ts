/**
 * Offline qualification of coordinator research servers on the pinned
 * OpenCode CLI: a real `opencode serve`, a local MCP server, no model.
 *
 * Proves the three things the adapter relies on: a server registered at
 * runtime connects and contributes `<server>_<tool>` ids; its ids can be told
 * apart from a project server whose name extends the research server's; and
 * the registration replaces a project entry under the same name.
 */
import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import {
  policyQualificationCli,
  withPolicyCliFixture,
} from "../../../../tests/conformance/execution-policy/vendor-cli.js";
import { openCodeHealthHeaders } from "./commands-server-health.js";
import {
  configureOpenCodeCoordinatorResearch,
  openCodeCoordinatorResearchToolIds,
} from "./opencode-coordinator-research.js";

const opencode = policyQualificationCli("opencode");

/** A stateless MCP server over plain JSON: just enough for OpenCode to list tools. */
function fixtureMcpServer(tools: string[]) {
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

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

describe("OpenCode coordinator research servers", () => {
  (opencode ? test : test.skip)(
    "registers a research server and allows exactly its tools",
    () =>
      withPolicyCliFixture(async (fixture) => {
        const research = fixtureMcpServer(["query-docs"]);
        const project = fixtureMcpServer(["query-docs"]);
        // The checkout declares a server whose name extends the research
        // server's, and a command-backed entry under the research name itself.
        await writeFile(
          `${fixture.cwd}/opencode.json`,
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            mcp: {
              context7_x: { type: "remote", url: `${project.url.origin}/mcp`, enabled: true },
              context7: { type: "local", command: ["false"], enabled: true },
            },
          }),
        );
        const port = await freePort();
        const password = "fixture-password";
        const child = Bun.spawn(
          [opencode!, "serve", "--port", String(port), "--hostname", "127.0.0.1"],
          {
            cwd: fixture.cwd,
            env: {
              ...fixture.env,
              OPENCODE_SERVER_PASSWORD: password,
              OPENCODE_SERVER_USERNAME: "opencode",
            },
            stdout: "ignore",
            stderr: "ignore",
          },
        );
        try {
          const headers = openCodeHealthHeaders(password);
          const deadline = Date.now() + 20_000;
          for (;;) {
            const ready = await fetch(
              `http://127.0.0.1:${port}/mcp?directory=${encodeURIComponent(fixture.cwd)}`,
              { headers },
            ).catch(() => undefined);
            if (ready?.ok) {
              const status = (await ready.json()) as Record<string, { status?: string }>;
              // Wait for the project server to settle so its tools are listed.
              if (status.context7_x?.status === "connected") break;
            }
            if (Date.now() > deadline) throw new Error("opencode serve did not become ready");
            await Bun.sleep(200);
          }
          const allowed = await configureOpenCodeCoordinatorResearch({
            serverKey: "local:fixture",
            port,
            password,
            directory: fixture.cwd,
            servers: [{ name: "context7", url: `${research.url.origin}/mcp` }],
          });
          expect(allowed).toEqual(["context7_query-docs"]);
          expect(openCodeCoordinatorResearchToolIds("local:fixture")).toEqual(allowed);
          const status = (await (
            await fetch(
              `http://127.0.0.1:${port}/mcp?directory=${encodeURIComponent(fixture.cwd)}`,
              { headers },
            )
          ).json()) as Record<string, { status?: string }>;
          // The registration took the project's command-backed entry's name,
          // and the project server beside it is still there with its own tools.
          expect(status.context7?.status).toBe("connected");
          expect(status.context7_x?.status).toBe("connected");
          expect(research.requests()).toBeGreaterThan(0);
        } finally {
          child.kill();
          await child.exited;
          research.stop();
          project.stop();
        }
      }),
    40_000,
  );
});
