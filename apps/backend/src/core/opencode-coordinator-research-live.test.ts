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
  ensureOpenCodeCoordinatorResearch,
  forgetOpenCodeCoordinatorResearch,
  invalidateOpenCodeCoordinatorResearch,
  openCodeCoordinatorResearchToolIds,
} from "./opencode-coordinator-research.js";

const opencode = policyQualificationCli("opencode");

import { OpenCodeProvider } from "./opencode-provider.js";
import { resolveNativeAgentExecutionPolicy } from "./native-agent-execution-policy.js";
import { fixtureMcpServer } from "./opencode-coordinator-research-test-support.js";

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
              context7: { type: "remote", url: `${project.url.origin}/mcp`, enabled: true },
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
        let provider: OpenCodeProvider | undefined;
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
          provider = new OpenCodeProvider(
            {
              agent: "opencode",
              baseUrl: `http://127.0.0.1:${port}`,
              authToken: password,
              directory: fixture.cwd,
            },
            {
              coordinatorResearchToolIds: () => openCodeCoordinatorResearchToolIds("local:fixture"),
              invalidateCoordinatorResearch: () =>
                invalidateOpenCodeCoordinatorResearch("local:fixture"),
              ensureCoordinatorResearch: () =>
                ensureOpenCodeCoordinatorResearch("local:fixture").then(() => undefined),
            },
          );
          const policy = resolveNativeAgentExecutionPolicy(
            { environmentType: "local", networkAccessMode: "restricted" },
            "coordinator",
            undefined,
            "search-and-mcp",
          );
          const session = await provider.createSession("coordinator", "Reload fixture", { policy });
          await provider.refreshCommands();
          expect(openCodeCoordinatorResearchToolIds("local:fixture")).toEqual([]);
          const beforeRestore = research.requests();
          await provider.synchronizeSessionPolicy(session, policy);
          expect(research.requests()).toBeGreaterThan(beforeRestore);
          expect(openCodeCoordinatorResearchToolIds("local:fixture")).toEqual(allowed);
          const restored = (await fetch(
            `http://127.0.0.1:${port}/session/${session}?directory=${encodeURIComponent(fixture.cwd)}`,
            { headers },
          ).then((response) => response.json())) as {
            permission: { permission: string; action: string }[];
          };
          const action = (tool: string) =>
            restored.permission.findLast(
              (rule) => rule.permission === tool || rule.permission === "*",
            )?.action;
          expect(action("context7_query-docs")).toBe("allow");
          expect(action("context7_x_query-docs")).toBe("deny");
        } finally {
          await provider?.dispose();
          forgetOpenCodeCoordinatorResearch("local:fixture");
          child.kill();
          await child.exited;
          research.stop();
          project.stop();
        }
      }),
    40_000,
  );
});
