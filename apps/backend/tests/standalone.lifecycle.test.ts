// Standalone backend: gateway compression metrics, signal exits and draining a local server process tree.
import { describe, expect, jest, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createTemporaryDirectory,
  startBackend,
  invokeBackend,
  waitForProcessExit,
  isProcessRunning,
  registerStandaloneCleanup,
} from "./standalone-test-support";

// A case can include backend startup, a real child-process tree, and graceful
// shutdown. The helper deadlines remain narrower so failures retain a specific
// diagnostic instead of Bun killing the fixture at its default five seconds.
jest.setTimeout(30_000);
registerStandaloneCleanup();

describe("standalone backend service", () => {
  test("passes CLI compression through to gateway metrics for each listener", async () => {
    const { url, token, readyMessage } = await startBackend(
      ["--control-host", "127.0.0.1", "--control-port", "0", "--compression", "on"],
      { ORKESTRATOR_GATEWAY_COMPRESSION: "body" },
    );
    const browserUrl = readyMessage.browserUrl;
    expect(browserUrl).toBeString();
    const authorization = { authorization: `Bearer ${token}` };

    const controlStatus = await Bun.fetch(new URL("/__orkestrator/status", url), {
      headers: authorization,
    });
    const browserStatus = await Bun.fetch(new URL("/__orkestrator/status", browserUrl as string), {
      headers: authorization,
    });
    expect(controlStatus.status).toBe(200);
    expect(browserStatus.status).toBe(200);

    const metricsResponse = await Bun.fetch(new URL("/__orkestrator/metrics", url), {
      headers: authorization,
    });
    expect(metricsResponse.status).toBe(200);
    const metrics = (await metricsResponse.json()) as {
      compression: { configuredMode: string };
      recentRouteSamples: Array<{
        route: string;
        listenerKind: string;
        effectiveCompressionMode: string;
      }>;
    };
    expect(metrics.compression.configuredMode).toBe("on");
    const statusSamples = metrics.recentRouteSamples.filter((sample) => sample.route === "status");
    expect(statusSamples).toContainEqual(
      expect.objectContaining({
        listenerKind: "control",
        effectiveCompressionMode: "off",
      }),
    );
    expect(statusSamples).toContainEqual(
      expect.objectContaining({
        listenerKind: "browser",
        effectiveCompressionMode: "on",
      }),
    );
  });

  test("stops cleanly when a service manager sends SIGTERM", async () => {
    const { child } = await startBackend();
    child.kill("SIGTERM");
    await expect(child.exited).resolves.toBe(0);
  });

  test("returns the shell-compatible SIGINT exit code", async () => {
    const { child } = await startBackend();
    child.kill("SIGINT");
    await expect(child.exited).resolves.toBe(130);
  });

  test("drains an active local server process tree before exiting", async () => {
    const worktreePath = await createTemporaryDirectory("orkestrator-standalone-worktree-");
    // The OpenCode start reads the user's OpenCode configuration and the
    // auth.json containers are handed; neither may be the developer's own.
    const isolatedHome = await createTemporaryDirectory("orkestrator-standalone-worktree-");
    let processMarkerPath = "";
    const homeEnv = {
      HOME: isolatedHome,
      XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
      XDG_DATA_HOME: path.join(isolatedHome, ".local", "share"),
    };
    const started = await startBackend([], homeEnv, async ({ dataDir }) => {
      processMarkerPath = path.join(dataDir, "fake-opencode-processes.json");
      const toolchainBinDir = path.join(dataDir, "toolchains", "bin");
      await mkdir(toolchainBinDir, { recursive: true });
      // The managed OpenCode 2 binary (`resolveOpenCode2Binary`); there is no PATH fallback.
      const executable = path.join(toolchainBinDir, "opencode2");
      const fakeServerPath = path.join(dataDir, "fake-opencode-server.cjs");
      const fakeServerSource = `
        const fs = require("node:fs");
        const http = require("node:http");
        const { spawn } = require("node:child_process");
        const descendant = spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 1_000)"],
          { stdio: "ignore" },
        );
        fs.writeFileSync(
          ${JSON.stringify(processMarkerPath)},
          JSON.stringify({
            serverPid: process.pid,
            descendantPid: descendant.pid,
            agentToolsUrl: process.env.ORKESTRATOR_AGENT_MCP_URL,
            agentToolsToken: process.env.ORKESTRATOR_AGENT_MCP_TOKEN,
          }),
        );
        http.createServer((request, response) => {
          const pathname = new URL(request.url, "http://127.0.0.1").pathname;
          // OpenCode 2's readiness route (\`localServerHealthPath\`), in its \`{ data }\` envelope.
          if (request.method === "GET" && pathname === "/api/info") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ data: { version: "2.2.6" } }));
            return;
          }
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ _tag: "NotFoundError", message: "Not found" }));
        }).listen(Number(process.argv[2]), "127.0.0.1");
      `;
      await writeFile(fakeServerPath, fakeServerSource);
      await writeFile(
        executable,
        `#!/bin/sh
PORT=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--port" ]; then shift; PORT="$1"; fi
  shift
done
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeServerPath)} "$PORT"
`,
      );
      await chmod(executable, 0o755);
      await writeFile(
        path.join(dataDir, "environments.json"),
        `${JSON.stringify(
          [
            {
              id: "env-local-server",
              projectId: "project-1",
              name: "Local",
              branch: "feature/local",
              containerId: null,
              status: "running",
              prUrl: null,
              prState: null,
              hasMergeConflicts: null,
              createdAt: new Date(0).toISOString(),
              networkAccessMode: "restricted",
              order: 0,
              environmentType: "local",
              worktreePath,
            },
          ],
          null,
          2,
        )}\n`,
      );
    });

    const result = (await invokeBackend(
      started.url,
      started.token,
      "start_local_opencode_server_cmd",
      { environmentId: "env-local-server" },
    )) as { pid: number };
    const processIds = JSON.parse(await readFile(processMarkerPath, "utf8")) as {
      serverPid: number;
      descendantPid: number;
      agentToolsUrl?: string;
      agentToolsToken?: string;
    };
    expect(result.pid).toBe(processIds.serverPid);
    expect(isProcessRunning(processIds.serverPid)).toBe(true);
    expect(isProcessRunning(processIds.descendantPid)).toBe(true);
    // The Orkestrator MCP credential is attached per session (`opencode2/mcp.ts`),
    // never handed to the server or the shells it runs.
    expect(processIds.agentToolsUrl).toBeUndefined();
    expect(processIds.agentToolsToken).toBeUndefined();

    started.child.kill("SIGTERM");
    await expect(started.child.exited).resolves.toBe(0);
    await Promise.all([
      waitForProcessExit(processIds.serverPid),
      waitForProcessExit(processIds.descendantPid),
    ]);
  });
});
