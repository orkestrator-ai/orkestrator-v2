import { afterAll, describe, expect, jest, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { waitForStandaloneBackendReady } from "./standalone-ready";

const root = path.resolve(import.meta.dir, "../../..");
const temporaryDirectories: string[] = [];
const processes: Bun.Subprocess[] = [];

// A case can include backend startup, a real child-process tree, and graceful
// shutdown. The helper deadlines remain narrower so failures retain a specific
// diagnostic instead of Bun killing the fixture at its default five seconds.
jest.setTimeout(30_000);

afterAll(async () => {
  for (const process of processes) process.kill("SIGTERM");
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function startBackend(
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
  prepare?: (paths: { dataDir: string; rendererRoot: string }) => Promise<void>,
): Promise<{
  url: string;
  token: string;
  readyMessage: Record<string, unknown>;
  child: Bun.Subprocess;
  dataDir: string;
}> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-standalone-test-"));
  temporaryDirectories.push(dataDir);
  const rendererRoot = path.join(dataDir, "renderer");
  await mkdir(rendererRoot);
  await writeFile(path.join(rendererRoot, "index.html"), "<!doctype html><title>Orkestrator</title>");
  await prepare?.({ dataDir, rendererRoot });
  const child = Bun.spawn([
    process.execPath,
    path.join(root, "apps/backend/dist/main.js"),
    "--host", "127.0.0.1",
    "--port", "0",
    "--allow-non-tailscale-bind",
    "--data-dir", dataDir,
    "--app-root", root,
    "--resource-root", root,
    "--renderer-root", rendererRoot,
    ...extraArgs,
  ], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...extraEnv },
  });
  processes.push(child);

  const ready = await waitForStandaloneBackendReady(child);
  return { ...ready, child, dataDir };
}

async function invokeBackend(
  url: string,
  token: string,
  command: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const response = await Bun.fetch(new URL("/__orkestrator/invoke", url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ command, args }),
  });
  const payload = await response.json() as { result?: unknown; error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Backend command failed: ${response.status}`);
  return payload.result;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (isProcessRunning(pid) && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  if (isProcessRunning(pid)) throw new Error(`Process did not exit: ${pid}`);
}

describe("standalone backend service", () => {
  test("serves the web app and invokes backend commands without Electron", async () => {
    const { url, token, readyMessage } = await startBackend();
    expect(readyMessage).not.toHaveProperty("token");
    expect(JSON.stringify(readyMessage)).not.toContain(token);
    const authorization = { authorization: `Bearer ${token}` };
    const invokeResponse = await Bun.fetch(new URL("/__orkestrator/invoke", url), {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ command: "greet", args: { name: "standalone" } }),
    });
    expect(invokeResponse.status).toBe(200);
    expect(await invokeResponse.json()).toEqual({
      result: "Hello, standalone! You've been greeted from the Orkestrator backend!",
    });

    const webResponse = await Bun.fetch(url, { headers: authorization });
    expect(webResponse.status).toBe(200);
    expect(webResponse.headers.get("content-type")).toContain("text/html");
  });

  test("passes CLI compression through to gateway metrics for each listener", async () => {
    const { url, token, readyMessage } = await startBackend(
      [
        "--control-host", "127.0.0.1",
        "--control-port", "0",
        "--compression", "on",
      ],
      { ORKESTRATOR_GATEWAY_COMPRESSION: "body" },
    );
    const browserUrl = readyMessage.browserUrl;
    expect(browserUrl).toBeString();
    const authorization = { authorization: `Bearer ${token}` };

    const controlStatus = await Bun.fetch(new URL("/__orkestrator/status", url), { headers: authorization });
    const browserStatus = await Bun.fetch(
      new URL("/__orkestrator/status", browserUrl as string),
      { headers: authorization },
    );
    expect(controlStatus.status).toBe(200);
    expect(browserStatus.status).toBe(200);

    const metricsResponse = await Bun.fetch(new URL("/__orkestrator/metrics", url), {
      headers: authorization,
    });
    expect(metricsResponse.status).toBe(200);
    const metrics = await metricsResponse.json() as {
      compression: { configuredMode: string };
      recentRouteSamples: Array<{
        route: string;
        listenerKind: string;
        effectiveCompressionMode: string;
      }>;
    };
    expect(metrics.compression.configuredMode).toBe("on");
    const statusSamples = metrics.recentRouteSamples.filter((sample) => sample.route === "status");
    expect(statusSamples).toContainEqual(expect.objectContaining({
      listenerKind: "control",
      effectiveCompressionMode: "off",
    }));
    expect(statusSamples).toContainEqual(expect.objectContaining({
      listenerKind: "browser",
      effectiveCompressionMode: "on",
    }));
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
    const worktreePath = await mkdtemp(path.join(os.tmpdir(), "orkestrator-standalone-worktree-"));
    temporaryDirectories.push(worktreePath);
    let processMarkerPath = "";
    const started = await startBackend([], {}, async ({ dataDir }) => {
      processMarkerPath = path.join(dataDir, "fake-opencode-processes.json");
      const toolchainBinDir = path.join(dataDir, "toolchains", "bin");
      await mkdir(toolchainBinDir, { recursive: true });
      const executable = path.join(toolchainBinDir, "opencode");
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
          if (request.method === "GET" && pathname === "/global/health") {
            response.writeHead(200);
            response.end();
            return;
          }
          if (request.method === "POST" && pathname === "/mcp") {
            request.resume();
            request.once("end", () => {
              response.writeHead(200, { "content-type": "application/json" });
              response.end(JSON.stringify({
                orkestrator: { status: "connected" },
              }));
            });
            return;
          }
          response.writeHead(404);
          response.end();
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
        `${JSON.stringify([{
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
        }], null, 2)}\n`,
      );
    });

    const result = await invokeBackend(
      started.url,
      started.token,
      "start_local_opencode_server_cmd",
      { environmentId: "env-local-server" },
    ) as { pid: number };
    const processIds = JSON.parse(await readFile(processMarkerPath, "utf8")) as {
      serverPid: number;
      descendantPid: number;
      agentToolsUrl?: string;
      agentToolsToken?: string;
    };
    expect(result.pid).toBe(processIds.serverPid);
    expect(isProcessRunning(processIds.serverPid)).toBe(true);
    expect(isProcessRunning(processIds.descendantPid)).toBe(true);
    expect(processIds.agentToolsUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/mcp$/,
    );
    expect(processIds.agentToolsToken).toMatch(/^[A-Za-z0-9_-]{32,128}$/);

    started.child.kill("SIGTERM");
    await expect(started.child.exited).resolves.toBe(0);
    await Promise.all([
      waitForProcessExit(processIds.serverPid),
      waitForProcessExit(processIds.descendantPid),
    ]);
  });

  test("can own a Tailscale Serve listener and publish its HTTPS URL", async () => {
    const testDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-tailscale-test-"));
    temporaryDirectories.push(testDir);
    const executable = path.join(testDir, "tailscale");
    const logFile = path.join(testDir, "calls.log");
    // Tracks the root mount separately from the user's own `/api` handler, so a
    // scoped teardown cannot masquerade as a full-listener removal. `/api` also
    // keeps the TCP entry alive after shutdown, which is the state a restart has
    // to tolerate.
    await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$*" >> "$TAILSCALE_TEST_LOG"
case " $* " in
  *" --set-path=/ off "*) rm -f "$TAILSCALE_TEST_LOG.root"; exit 0 ;;
  *" off "*) rm -f "$TAILSCALE_TEST_LOG.root" "$TAILSCALE_TEST_LOG.api"; exit 0 ;;
esac
if [ "$*" = "serve status --json" ]; then
  handlers='"/api":{"Proxy":"http://127.0.0.1:9000"}'
  if [ -f "$TAILSCALE_TEST_LOG.root" ]; then
    port=$(cat "$TAILSCALE_TEST_LOG.port")
    handlers=$(printf '"/":{"Proxy":"http://127.0.0.1:%s"},%s' "$port" "$handlers")
  fi
  printf '{"TCP":{"443":{"HTTPS":true}},"Web":{"workstation.example.ts.net:443":{"Handlers":{%s}}}}\\n' "$handlers"
  exit 0
fi
for arg in "$@"; do last_arg="$arg"; done
printf '%s' "\${last_arg##*:}" > "$TAILSCALE_TEST_LOG.port"
touch "$TAILSCALE_TEST_LOG.root"
printf 'Available within your tailnet:\\nhttps://workstation.example.ts.net\\n'
`);
    await chmod(executable, 0o755);

    const { child, readyMessage } = await startBackend(
      ["--tailscale-serve", "--tailscale-bin", executable],
      { TAILSCALE_TEST_LOG: logFile },
    );

    expect(readyMessage.browserUrl).toBe("https://workstation.example.ts.net/");
    expect(readyMessage.bindAddress).toBe("127.0.0.1");
    child.kill("SIGTERM");
    await expect(child.exited).resolves.toBe(0);

    const calls = await readFile(logFile, "utf8");
    expect(calls).toContain("serve --bg --yes --https=443 http://127.0.0.1:");
    expect(calls).toContain("serve --yes --https=443 --set-path=/ off");
    // The whole-listener form would have taken `/api` with it.
    expect(calls).not.toContain("serve --yes --https=443 off\n");

    // A second backend must be able to claim the port again even though `/api`
    // is still holding it open.
    const restarted = await startBackend(
      ["--tailscale-serve", "--tailscale-bin", executable],
      { TAILSCALE_TEST_LOG: logFile },
    );
    expect(restarted.readyMessage.browserUrl).toBe("https://workstation.example.ts.net/");
    restarted.child.kill("SIGTERM");
    await expect(restarted.child.exited).resolves.toBe(0);
  }, 60_000);

  test("exits without a leftover listener when environment-managed Serve setup fails", async () => {
    const testDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-tailscale-fail-"));
    temporaryDirectories.push(testDir);
    const executable = path.join(testDir, "tailscale");
    const logFile = path.join(testDir, "calls.log");
    await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$*" >> "$TAILSCALE_TEST_LOG"
if [ "$*" = "serve status --json" ]; then
  printf '{}\\n'
  exit 0
fi
echo 'Tailscale HTTPS is not enabled for this tailnet' >&2
exit 1
`);
    await chmod(executable, 0o755);

    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-standalone-test-"));
    temporaryDirectories.push(dataDir);
    const rendererRoot = path.join(dataDir, "renderer");
    await mkdir(rendererRoot);
    await writeFile(path.join(rendererRoot, "index.html"), "<!doctype html><title>Orkestrator</title>");

    const child = Bun.spawn([
      process.execPath,
      path.join(root, "apps/backend/dist/main.js"),
      "--port", "0",
      "--data-dir", dataDir,
      "--app-root", root,
      "--resource-root", root,
      "--renderer-root", rendererRoot,
    ], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ORKESTRATOR_TAILSCALE_SERVE: "1",
        ORKESTRATOR_TAILSCALE_BIN: executable,
        TAILSCALE_TEST_LOG: logFile,
      },
    });
    processes.push(child);

    await expect(child.exited).resolves.not.toBe(0);
    expect(await new Response(child.stderr).text()).toContain(
      "Unable to configure Tailscale Serve: Tailscale HTTPS is not enabled for this tailnet",
    );
    const calls = await readFile(logFile, "utf8");
    expect(calls).toContain("serve status --json");
    expect(calls).toContain("serve --bg --yes --https=443 http://127.0.0.1:");
    // Configuration never succeeded, so shutdown must not remove anyone's listener.
    expect(calls).not.toContain("off");
  });

  test("rejects Tailscale Serve with a non-IPv4-loopback listener", async () => {
    const child = Bun.spawn([
      process.execPath,
      path.join(root, "apps/backend/dist/main.js"),
      "--tailscale-serve",
      "--host", "::1",
    ], { stdout: "pipe", stderr: "pipe", env: process.env });
    processes.push(child);

    await expect(child.exited).resolves.not.toBe(0);
    expect(await new Response(child.stderr).text()).toContain(
      "--tailscale-serve requires --host 127.0.0.1",
    );
  });
});
