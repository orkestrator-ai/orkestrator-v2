import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { CommandContext } from "../../../apps/backend/src/core/commands";
import type { Environment } from "../../../apps/backend/src/core/models";

const { createCommandRegistry, __testing } = await import("../../../apps/backend/src/core/commands");

type Handler = NonNullable<ReturnType<typeof createCommandRegistry>["get"] extends (name: string) => infer T ? T : never>;

const originalPath = process.env.PATH;
const originalHome = process.env.HOME;
const originalHomedir = os.homedir;
const originalDockerLog = process.env.FAKE_DOCKER_LOG;
const originalDockerStatus = process.env.FAKE_DOCKER_STATUS;
const originalDockerPort = process.env.FAKE_DOCKER_PORT;
const originalDockerFailInfo = process.env.FAKE_DOCKER_FAIL_INFO;
const originalDockerFailImage = process.env.FAKE_DOCKER_FAIL_IMAGE;
const originalDockerNoPort = process.env.FAKE_DOCKER_NO_PORT;
const originalCodexBridgeToken = process.env.FAKE_CODEX_BRIDGE_TOKEN;
const originalClaudeBridgeToken = process.env.FAKE_CLAUDE_BRIDGE_TOKEN;
const originalOpenCodeServerPassword = process.env.FAKE_OPENCODE_SERVER_PASSWORD;
const originalDockerHostResolves = process.env.FAKE_DOCKER_HOST_RESOLVES;
const originalDockerHostsOutput = process.env.FAKE_DOCKER_HOSTS_OUTPUT;
const originalDockerGateway = process.env.FAKE_DOCKER_GATEWAY;
const originalClaudeAgentToolsFingerprint = process.env.FAKE_CLAUDE_AGENT_TOOLS_FINGERPRINT;
const originalCodexAgentToolsFingerprint = process.env.FAKE_CODEX_AGENT_TOOLS_FINGERPRINT;
let root = "";
let binDir = "";
let commandLog = "";
let fakeHome = "";

const DOCKER_SCRIPT = `#!/bin/sh
printf 'docker %s\n' "$*" >> "$FAKE_DOCKER_LOG"

if [ "$1" = "info" ]; then
  [ "\${FAKE_DOCKER_FAIL_INFO:-}" = "1" ] && { echo "docker unavailable" >&2; exit 19; }
  exit 0
fi
if [ "$1" = "version" ]; then
  printf '26.1.4\n'
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  [ "\${FAKE_DOCKER_FAIL_IMAGE:-}" = "1" ] && { echo "image missing" >&2; exit 20; }
  printf '[]\n'
  exit 0
fi
if [ "$1" = "create" ]; then
  printf 'container-created-123\n'
  exit 0
fi
if [ "$1" = "inspect" ] && [ "$2" = "-f" ]; then
  printf '%s\n' "\${FAKE_DOCKER_STATUS:-running}"
  exit 0
fi
if [ "$1" = "inspect" ] && [ "$2" = "--format" ]; then
  printf '%s\n' "\${FAKE_DOCKER_GATEWAY:-172.17.0.1}"
  exit 0
fi
if [ "$1" = "ps" ] && [ "$2" = "-a" ]; then
  case " $* " in
    *" -q "*) printf 'container-a\ncontainer-b\n' ;;
    *) printf 'container-a\talpha\ncontainer-b\tbeta\n' ;;
  esac
  exit 0
fi
if [ "$1" = "ps" ] && [ "$2" = "-q" ]; then
  printf 'container-a\n'
  exit 0
fi
if [ "$1" = "images" ] && [ "$2" = "-q" ]; then
  printf 'image-a\nimage-a\nimage-b\n'
  exit 0
fi
if [ "$1" = "port" ]; then
  [ "\${FAKE_DOCKER_NO_PORT:-}" = "1" ] && exit 1
  printf '0.0.0.0:%s\n' "\${FAKE_DOCKER_PORT:-43123}"
  exit 0
fi
if [ "$1" = "logs" ]; then
  case " $* " in
    *" -f "*) printf 'stream stdout\n'; printf 'stream stderr\n' >&2 ;;
    *) printf 'historical container log\n' ;;
  esac
  exit 0
fi
if [ "$1" = "system" ] && [ "$2" = "prune" ]; then
  printf 'Deleted Containers:\ncontainer-old\nTotal reclaimed space: 1.25GB\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  case "$*" in
    *"getent hosts host.docker.internal"*)
      if [ -n "\${FAKE_DOCKER_HOSTS_OUTPUT:-}" ]; then
        printf '%s' "\${FAKE_DOCKER_HOSTS_OUTPUT}"
      elif [ "\${FAKE_DOCKER_HOST_RESOLVES:-}" = "1" ]; then
        printf '%s %s\n' "\${FAKE_DOCKER_GATEWAY:-172.17.0.1}" host.docker.internal
      fi
      ;;
    *claude-agent-tools-fingerprint*) printf '%s' "\${FAKE_CLAUDE_AGENT_TOOLS_FINGERPRINT:-}" ;;
    *codex-agent-tools-fingerprint*) printf '%s' "\${FAKE_CODEX_AGENT_TOOLS_FINGERPRINT:-}" ;;
    *codex-bridge-token*) printf '%s' "\${FAKE_CODEX_BRIDGE_TOKEN:-}" ;;
    *claude-bridge-token*) printf '%s' "\${FAKE_CLAUDE_BRIDGE_TOKEN:-}" ;;
    *opencode-server-password*) printf '%s' "\${FAKE_OPENCODE_SERVER_PASSWORD:-}" ;;
    *opencode-serve.log*) printf 'opencode log\n' ;;
    *claude-bridge.log*) printf 'claude log\n' ;;
    *codex-bridge.log*) printf 'codex log\n' ;;
  esac
  exit 0
fi
exit 0
`;

const LAUNCHER_SCRIPT = `#!/bin/sh
printf '%s %s\n' "\${0##*/}" "$*" >> "$FAKE_DOCKER_LOG"
`;

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "environment-1",
    projectId: "project-1",
    name: "feature-environment",
    branch: "feature/process-commands",
    containerId: "container-existing",
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    allowedDomains: [],
    order: 0,
    environmentType: "containerized",
    worktreePath: null,
    ...overrides,
  };
}

function createContext(initialEnvironment = environment()): {
  context: CommandContext;
  updates: Array<Record<string, unknown>>;
  added: Environment[];
  events: Array<{ event: string; payload: unknown }>;
} {
  const updates: Array<Record<string, unknown>> = [];
  const added: Environment[] = [];
  const events: Array<{ event: string; payload: unknown }> = [];
  const context = {
    appRoot: root,
    resourceRoot: root,
    emit: mock((event: string, payload: unknown) => events.push({ event, payload })),
    storage: {
      getEnvironment: mock(async (id: string) => id === initialEnvironment.id ? initialEnvironment : null),
      loadEnvironments: mock(async () => [initialEnvironment]),
      updateEnvironment: mock(async (id: string, update: Record<string, unknown>) => {
        if (id !== initialEnvironment.id) throw new Error(`Environment not found: ${id}`);
        updates.push(update);
        Object.assign(initialEnvironment, update);
        return initialEnvironment;
      }),
      getProject: mock(async (id: string) => id === "project-1" ? {
        id: "project-1",
        name: "Project",
        gitUrl: "https://github.com/example/project.git",
        localPath: null,
        addedAt: new Date(0).toISOString(),
        order: 0,
      } : null),
      loadConfig: mock(async () => ({
        version: "1.0.0",
        global: { allowedDomains: [] },
        repositories: { "project-1": { defaultBranch: "main", prBaseBranch: "main" } },
      })),
      addEnvironment: mock(async (item: Environment) => {
        added.push(item);
        return item;
      }),
    },
  } as unknown as CommandContext;
  return { context, updates, added, events };
}

let registry: ReturnType<typeof createCommandRegistry>;
let fixture: ReturnType<typeof createContext>;

async function invoke(name: string, args: Record<string, unknown> = {}, context = fixture.context): Promise<unknown> {
  const handler = registry.get(name) as Handler | undefined;
  expect(handler).toBeDefined();
  return handler!(args, context);
}

async function readCommandLog(): Promise<string> {
  return fs.readFile(commandLog, "utf8").catch(() => "");
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function startHealthServer(status = 200): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_request, response) => {
    response.writeHead(status);
    response.end("ok");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

const startHealthyServer = () => startHealthServer(200);

async function startOpenCodeServer(): Promise<{
  port: number;
  close: () => Promise<void>;
  configurations: Array<Record<string, unknown>>;
}> {
  const configurations: Array<Record<string, unknown>> = [];
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
      });
      response.end();
      return;
    }
    if (request.method === "GET" && pathname === "/global/health") {
      response.writeHead(200, { "access-control-allow-origin": "*" });
      response.end("ok");
      return;
    }
    if (request.method === "POST" && pathname === "/mcp") {
      let body = "";
      for await (const chunk of request) body += chunk;
      configurations.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      });
      response.end(JSON.stringify({ orkestrator: { status: "connected" } }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    ),
    configurations,
  };
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-process-command-coverage-"));
  binDir = path.join(root, "bin");
  commandLog = path.join(root, "commands.log");
  fakeHome = path.join(root, "home");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(fakeHome, { recursive: true });
  await fs.writeFile(path.join(binDir, "docker"), DOCKER_SCRIPT);
  await fs.chmod(path.join(binDir, "docker"), 0o755);
  for (const executable of ["gh", "open", "xdg-open", "explorer.exe", "explorer", "code", "cursor"]) {
    await fs.writeFile(path.join(binDir, executable), LAUNCHER_SCRIPT);
    await fs.chmod(path.join(binDir, executable), 0o755);
  }
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.HOME = fakeHome;
  process.env.FAKE_DOCKER_LOG = commandLog;
  Object.defineProperty(os, "homedir", { configurable: true, value: () => fakeHome });
});

beforeEach(async () => {
  registry = createCommandRegistry();
  fixture = createContext();
  await fs.writeFile(commandLog, "");
  delete process.env.FAKE_DOCKER_STATUS;
  delete process.env.FAKE_DOCKER_PORT;
  delete process.env.FAKE_DOCKER_FAIL_INFO;
  delete process.env.FAKE_DOCKER_FAIL_IMAGE;
  delete process.env.FAKE_DOCKER_NO_PORT;
  delete process.env.FAKE_CODEX_BRIDGE_TOKEN;
  delete process.env.FAKE_CLAUDE_BRIDGE_TOKEN;
  delete process.env.FAKE_OPENCODE_SERVER_PASSWORD;
  delete process.env.FAKE_DOCKER_HOST_RESOLVES;
  delete process.env.FAKE_DOCKER_HOSTS_OUTPUT;
  delete process.env.FAKE_DOCKER_GATEWAY;
  delete process.env.FAKE_CLAUDE_AGENT_TOOLS_FINGERPRINT;
  delete process.env.FAKE_CODEX_AGENT_TOOLS_FINGERPRINT;
});

afterEach(() => {
  mock.restore();
});

afterAll(async () => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  Object.defineProperty(os, "homedir", { configurable: true, value: originalHomedir });
  if (originalDockerLog === undefined) delete process.env.FAKE_DOCKER_LOG;
  else process.env.FAKE_DOCKER_LOG = originalDockerLog;
  if (originalDockerStatus === undefined) delete process.env.FAKE_DOCKER_STATUS;
  else process.env.FAKE_DOCKER_STATUS = originalDockerStatus;
  if (originalDockerPort === undefined) delete process.env.FAKE_DOCKER_PORT;
  else process.env.FAKE_DOCKER_PORT = originalDockerPort;
  if (originalDockerFailInfo === undefined) delete process.env.FAKE_DOCKER_FAIL_INFO;
  else process.env.FAKE_DOCKER_FAIL_INFO = originalDockerFailInfo;
  if (originalDockerFailImage === undefined) delete process.env.FAKE_DOCKER_FAIL_IMAGE;
  else process.env.FAKE_DOCKER_FAIL_IMAGE = originalDockerFailImage;
  if (originalDockerNoPort === undefined) delete process.env.FAKE_DOCKER_NO_PORT;
  else process.env.FAKE_DOCKER_NO_PORT = originalDockerNoPort;
  if (originalCodexBridgeToken === undefined) delete process.env.FAKE_CODEX_BRIDGE_TOKEN;
  else process.env.FAKE_CODEX_BRIDGE_TOKEN = originalCodexBridgeToken;
  if (originalClaudeBridgeToken === undefined) delete process.env.FAKE_CLAUDE_BRIDGE_TOKEN;
  else process.env.FAKE_CLAUDE_BRIDGE_TOKEN = originalClaudeBridgeToken;
  if (originalOpenCodeServerPassword === undefined) delete process.env.FAKE_OPENCODE_SERVER_PASSWORD;
  else process.env.FAKE_OPENCODE_SERVER_PASSWORD = originalOpenCodeServerPassword;
  if (originalDockerHostResolves === undefined) delete process.env.FAKE_DOCKER_HOST_RESOLVES;
  else process.env.FAKE_DOCKER_HOST_RESOLVES = originalDockerHostResolves;
  if (originalDockerHostsOutput === undefined) delete process.env.FAKE_DOCKER_HOSTS_OUTPUT;
  else process.env.FAKE_DOCKER_HOSTS_OUTPUT = originalDockerHostsOutput;
  if (originalDockerGateway === undefined) delete process.env.FAKE_DOCKER_GATEWAY;
  else process.env.FAKE_DOCKER_GATEWAY = originalDockerGateway;
  if (originalClaudeAgentToolsFingerprint === undefined) delete process.env.FAKE_CLAUDE_AGENT_TOOLS_FINGERPRINT;
  else process.env.FAKE_CLAUDE_AGENT_TOOLS_FINGERPRINT = originalClaudeAgentToolsFingerprint;
  if (originalCodexAgentToolsFingerprint === undefined) delete process.env.FAKE_CODEX_AGENT_TOOLS_FINGERPRINT;
  else process.env.FAKE_CODEX_AGENT_TOOLS_FINGERPRINT = originalCodexAgentToolsFingerprint;
  await fs.rm(root, { recursive: true, force: true });
});

describe("process and platform command behavior", () => {
  test("checks Docker availability, version, and base image failures", async () => {
    expect(await invoke("check_docker")).toBe(true);
    expect(await invoke("docker_version")).toBe("26.1.4");
    expect(await invoke("check_base_image")).toBe(true);

    process.env.FAKE_DOCKER_FAIL_INFO = "1";
    process.env.FAKE_DOCKER_FAIL_IMAGE = "1";
    expect(await invoke("check_docker")).toBe(false);
    expect(await invoke("check_base_image")).toBe(false);
  });

  test("provisions and controls a container with validated arguments", async () => {
    expect(await invoke("provision_environment", { environmentId: "environment-1" })).toBe("container-created-123");
    expect(fixture.updates).toContainEqual({ containerId: "container-created-123" });

    await invoke("docker_start_container", { containerId: "container-a" });
    await invoke("docker_stop_container", { containerId: "container-a" });
    await invoke("docker_remove_container", { containerId: "container-a" });
    await expect(invoke("docker_start_container", { containerId: 7 })).rejects.toThrow("Expected containerId to be a string");

    const log = await readCommandLog();
    expect(log).toContain("docker create --name feature-environment");
    expect(log).toContain("GIT_URL=https://github.com/example/project.git");
    expect(log).toContain("docker start container-a");
    expect(log).toContain("docker stop container-a");
    expect(log).toContain("docker rm -f container-a");
  });

  test("parses container status, listings, ports, logs, prune output, and aggregate stats", async () => {
    expect(await invoke("docker_container_status", { containerId: "container-a" })).toBe("running");
    process.env.FAKE_DOCKER_STATUS = "paused";
    expect(await invoke("docker_container_status", { containerId: "container-a" })).toBe("stopped");
    process.env.FAKE_DOCKER_STATUS = "unexpected";
    expect(await invoke("docker_container_status", { containerId: "container-a" })).toBe("error");

    expect(await invoke("list_docker_containers")).toEqual([
      ["container-a", "alpha"],
      ["container-b", "beta"],
    ]);
    expect(await invoke("get_container_host_port", { containerId: "container-a", containerPort: 4096 })).toBe(43123);
    process.env.FAKE_DOCKER_NO_PORT = "1";
    expect(await invoke("get_container_host_port", { containerId: "container-a", containerPort: 4096 })).toBeNull();
    delete process.env.FAKE_DOCKER_NO_PORT;

    expect(await invoke("get_container_logs", { containerId: "container-a", tail: "25" })).toBe("historical container log\n");
    await invoke("stream_container_logs", { containerId: "container-a" });
    await waitFor(() => fixture.events.length === 2, "stdout and stderr container-log events");
    expect(fixture.events).toEqual([
      { event: "container-log", payload: { containerId: "container-a", line: "stream stdout\n" } },
      { event: "container-log", payload: { containerId: "container-a", line: "stream stderr\n" } },
    ]);

    expect(await invoke("docker_system_prune", { pruneVolumes: true })).toEqual({
      containersDeleted: 0,
      imagesDeleted: 0,
      networksDeleted: 0,
      volumesDeleted: 0,
      spaceReclaimed: "1.25GB",
    });
    expect(await invoke("get_docker_system_stats")).toMatchObject({
      containersRunning: 1,
      containersTotal: 2,
      imagesTotal: 2,
      memoryUsed: 0,
      diskUsed: 0,
    });
    expect(await readCommandLog()).toContain("docker system prune -f --volumes");
  });

  test("reattaches a container and persists its inspected status", async () => {
    const result = await invoke("reattach_container", {
      projectId: "project-1",
      containerId: "0123456789abcdef",
    }) as Environment;

    expect(result.name).toBe("reattached-01234567");
    expect(result.containerId).toBe("0123456789abcdef");
    expect(result.status).toBe("running");
    expect(fixture.added).toHaveLength(1);
  });

  test("controls bridge processes, reads logs and preferences, and reports port health", async () => {
    await invoke("stop_opencode_server", { containerId: "container-a" });
    await invoke("stop_claude_server", { containerId: "container-a" });
    await invoke("stop_codex_server", { containerId: "container-a" });
    expect(await invoke("get_opencode_server_log", { containerId: "container-a" })).toBe("opencode log\n");
    expect(await invoke("get_claude_server_log", { containerId: "container-a" })).toBe("claude log\n");
    expect(await invoke("get_codex_server_log", { containerId: "container-a" })).toBe("codex log\n");

    process.env.FAKE_DOCKER_NO_PORT = "1";
    expect(await invoke("get_opencode_server_status", { containerId: "container-a" })).toEqual({ running: false, hostPort: null });
    expect(await invoke("get_claude_server_status", { containerId: "container-a" })).toEqual({ running: false, hostPort: null });
    expect(await invoke("get_codex_server_status", { containerId: "container-a" })).toEqual({ running: false, hostPort: null });
    delete process.env.FAKE_DOCKER_NO_PORT;

    const healthyStatus = await startHealthServer(200);
    process.env.FAKE_DOCKER_PORT = String(healthyStatus.port);
    process.env.FAKE_OPENCODE_SERVER_PASSWORD = "o".repeat(43);
    try {
      expect(
        await invoke("get_opencode_server_status", { containerId: "container-a" }),
      ).toEqual({
        running: true,
        hostPort: healthyStatus.port,
        authToken: "o".repeat(43),
      });
      for (const agent of ["claude", "codex"]) {
        expect(
          await invoke(`get_${agent}_server_status`, { containerId: "container-a" }),
        ).toEqual({ running: true, hostPort: healthyStatus.port });
      }
    } finally {
      await healthyStatus.close();
    }

    const unhealthyStatus = await startHealthServer(503);
    process.env.FAKE_DOCKER_PORT = String(unhealthyStatus.port);
    try {
      for (const agent of ["opencode", "claude", "codex"]) {
        expect(
          await invoke(`get_${agent}_server_status`, { containerId: "container-a" }),
        ).toEqual({ running: false, hostPort: unhealthyStatus.port });
      }
    } finally {
      await unhealthyStatus.close();
    }

    expect(await invoke("get_opencode_model_preferences")).toEqual({ recent: [], favorite: [], variant: {} });
    const preferencePath = path.join(fakeHome, ".local", "state", "opencode", "model.json");
    await fs.mkdir(path.dirname(preferencePath), { recursive: true });
    await fs.writeFile(preferencePath, JSON.stringify({ recent: ["provider/model"], favorite: [], variant: { "provider/model": "fast" } }));
    expect(await invoke("get_opencode_model_preferences")).toEqual({
      recent: ["provider/model"],
      favorite: [],
      variant: { "provider/model": "fast" },
    });

    const healthy = await startHealthyServer();
    process.env.FAKE_DOCKER_PORT = String(healthy.port);
    process.env.FAKE_CODEX_BRIDGE_TOKEN = "a".repeat(43);
    process.env.FAKE_CLAUDE_BRIDGE_TOKEN = "b".repeat(43);
    process.env.FAKE_OPENCODE_SERVER_PASSWORD = "o".repeat(43);
    try {
      expect(await invoke("start_opencode_server", { containerId: "container-a" })).toEqual({
        hostPort: healthy.port,
        wasRunning: true,
        authToken: "o".repeat(43),
      });
      expect(await invoke("start_codex_server", { containerId: "container-a" })).toEqual({
        hostPort: healthy.port,
        wasRunning: true,
        authToken: "a".repeat(43),
      });
      expect(await invoke("start_claude_server", { containerId: "container-a" })).toEqual({
        hostPort: healthy.port,
        wasRunning: true,
        authToken: "b".repeat(43),
      });
    } finally {
      await healthy.close();
    }
  });

  test("rehydrates OpenCode agent tools from status and repairs legacy container host resolution", async () => {
    const openCode = await startOpenCodeServer();
    process.env.FAKE_DOCKER_PORT = String(openCode.port);
    process.env.FAKE_OPENCODE_SERVER_PASSWORD = "o".repeat(43);
    const connection = {
      url: "http://host.docker.internal:45678/mcp",
      token: "project-scoped-secret-token",
    };
    const agentTools = {
      connection: mock(() => connection),
      revokeEnvironment: mock(() => undefined),
    };
    const context = {
      ...fixture.context,
      agentTools,
    } as CommandContext;
    try {
      await expect(invoke(
        "get_opencode_server_status",
        { containerId: "container-existing" },
        context,
      )).resolves.toEqual({
        running: true,
        hostPort: openCode.port,
        authToken: "o".repeat(43),
      });
      expect(agentTools.connection).toHaveBeenCalledWith(
        "environment-1",
        "project-1",
        "container",
      );
      expect(openCode.configurations).toEqual([
        expect.objectContaining({
          name: "orkestrator",
          config: expect.objectContaining({
            url: connection.url,
            headers: { Authorization: `Bearer ${connection.token}` },
          }),
        }),
      ]);

      const log = await readCommandLog();
      expect(log).toContain(
        "docker inspect --format {{range .NetworkSettings.Networks}}{{println .Gateway}}{{end}} container-existing",
      );
      expect(log).toContain("docker exec --user root container-existing");
      expect(log).not.toContain(connection.token);
    } finally {
      await openCode.close();
    }
  });

  test("does not rewrite container hosts when Docker already resolves the agent-tools host", async () => {
    process.env.FAKE_DOCKER_HOST_RESOLVES = "1";
    await __testing.ensureContainerAgentToolsHost("container-existing");
    const log = await readCommandLog();
    expect(log).toContain("getent hosts host.docker.internal");
    expect(log).toContain("docker inspect --format");
    expect(log).not.toContain("docker exec --user root");
  });

  test("rewrites a stale host.docker.internal mapping before trusting the alias", async () => {
    process.env.FAKE_DOCKER_HOSTS_OUTPUT = "10.0.0.7 host.docker.internal\n";
    process.env.FAKE_DOCKER_GATEWAY = "172.17.0.1";

    await __testing.ensureContainerAgentToolsHost("container-existing");

    const log = await readCommandLog();
    expect(log).toContain("getent hosts host.docker.internal");
    expect(log).toContain(
      "docker inspect --format {{range .NetworkSettings.Networks}}{{println .Gateway}}{{end}} container-existing",
    );
    expect(log).toContain("docker exec --user root container-existing");
  });

  test("fails closed when Docker does not report a usable gateway for the alias repair", async () => {
    process.env.FAKE_DOCKER_GATEWAY = "not-an-ip";

    await expect(
      __testing.ensureContainerAgentToolsHost("container-existing"),
    ).rejects.toThrow("Could not determine the Docker host gateway");

    const log = await readCommandLog();
    expect(log).toContain(
      "docker inspect --format {{range .NetworkSettings.Networks}}{{println .Gateway}}{{end}} container-existing",
    );
    expect(log).not.toContain("docker exec --user root container-existing");
  });

  test("status reuses Claude and Codex bridges with the current agent-tools fingerprint", async () => {
    const healthy = await startHealthyServer();
    process.env.FAKE_DOCKER_PORT = String(healthy.port);
    process.env.FAKE_DOCKER_HOST_RESOLVES = "1";
    process.env.FAKE_CLAUDE_BRIDGE_TOKEN = "c".repeat(43);
    process.env.FAKE_CODEX_BRIDGE_TOKEN = "d".repeat(43);
    const connection = {
      url: "http://host.docker.internal:45678/mcp",
      token: "current-project-token",
    };
    const fingerprint = __testing.agentToolConnectionFingerprint(connection);
    process.env.FAKE_CLAUDE_AGENT_TOOLS_FINGERPRINT = fingerprint;
    process.env.FAKE_CODEX_AGENT_TOOLS_FINGERPRINT = fingerprint;
    const agentTools = {
      connection: mock(() => connection),
      revokeEnvironment: mock(() => undefined),
    };
    const context = { ...fixture.context, agentTools } as CommandContext;
    try {
      await expect(invoke(
        "get_claude_server_status",
        { containerId: "container-existing" },
        context,
      )).resolves.toEqual({
        running: true,
        hostPort: healthy.port,
        authToken: "c".repeat(43),
      });
      await expect(invoke(
        "get_codex_server_status",
        { containerId: "container-existing" },
        context,
      )).resolves.toEqual({
        running: true,
        hostPort: healthy.port,
        authToken: "d".repeat(43),
      });
      expect(agentTools.connection).toHaveBeenCalledTimes(2);
      const log = await readCommandLog();
      expect(log).not.toContain("pkill -f");
      expect(log).not.toContain(connection.token);
    } finally {
      await healthy.close();
    }
  });

  test("loads and validates the durable OpenCode model catalogue", async () => {
    const cached = {
      schemaVersion: 2 as const,
      projectId: "project-a",
      catalogVersion: "cached",
      updatedAt: "2026-07-27T12:00:00.000Z",
      models: [],
    };
    const getOpenCodeModelCatalog = mock(async (_projectId: string) => cached);
    const cacheOpenCodeModelCatalog = mock(async (
      _projectId: string,
      models: unknown[],
    ) => ({
      ...cached,
      catalogVersion: "updated",
      models,
    }));
    const context = {
      ...fixture.context,
      storage: {
        ...fixture.context.storage,
        getOpenCodeModelCatalog,
        cacheOpenCodeModelCatalog,
      },
    } as CommandContext;

    expect(
      await invoke(
        "get_opencode_model_catalog_cache",
        { projectId: " project-a " },
        context,
      ),
    ).toEqual(cached);
    expect(getOpenCodeModelCatalog).toHaveBeenCalledWith("project-a");

    const models = [
      {
        id: " openrouter/openai/gpt-5 ",
        name: " GPT-5 ",
        provider: " openrouter ",
        variants: [" low ", "high"],
        inputCost: 0,
        outputCost: Number.MAX_VALUE,
        contextWindow: Number.MAX_SAFE_INTEGER,
      },
    ];
    expect(
      await invoke(
        "cache_opencode_model_catalog",
        { projectId: " project-a ", models },
        context,
      ),
    ).toEqual({
      ...cached,
      catalogVersion: "updated",
      models: [{
        id: "openrouter/openai/gpt-5",
        name: "GPT-5",
        provider: "openrouter",
        variants: ["low", "high"],
        inputCost: 0,
        outputCost: Number.MAX_VALUE,
        contextWindow: Number.MAX_SAFE_INTEGER,
      }],
    });
    expect(cacheOpenCodeModelCatalog).toHaveBeenCalledWith("project-a", [{
      id: "openrouter/openai/gpt-5",
      name: "GPT-5",
      provider: "openrouter",
      variants: ["low", "high"],
      inputCost: 0,
      outputCost: Number.MAX_VALUE,
      contextWindow: Number.MAX_SAFE_INTEGER,
    }]);

    await expect(
      invoke(
        "cache_opencode_model_catalog",
        { projectId: "project-a", models: [{ id: "missing-fields" }] },
        context,
      ),
    ).rejects.toThrow("models[0].name");
  });

  test("caches the valid models in a batch instead of rejecting it wholesale", async () => {
    // The catalogue is best-effort data assembled from whatever a provider
    // reports and the renderer only logs a rejection, so one rogue model must
    // not silently disable caching for the whole project.
    const cacheOpenCodeModelCatalog = mock(async (_projectId: string, models: unknown) => ({
      schemaVersion: 2,
      projectId: "project-a",
      catalogVersion: "v1",
      updatedAt: "2026-07-27T12:00:00.000Z",
      models,
    }));
    const context = {
      ...fixture.context,
      storage: { ...fixture.context.storage, cacheOpenCodeModelCatalog },
    } as CommandContext;

    await invoke(
      "cache_opencode_model_catalog",
      {
        projectId: "project-a",
        models: [
          { id: "openai/good", name: "Good", provider: "openai" },
          // Every rejection reason, one per entry.
          { id: "openai/nan-cost", name: "NaN", provider: "openai", inputCost: Number.NaN },
          { id: "openai/unknown-key", name: "Unknown", provider: "openai", tier: "pro" },
          { id: " ", name: "Blank id", provider: "openai" },
          null,
          { id: "openai/also-good", name: "Also Good", provider: "openai", variants: ["high"] },
        ],
      },
      context,
    );

    expect(cacheOpenCodeModelCatalog).toHaveBeenCalledWith("project-a", [
      { id: "openai/good", name: "Good", provider: "openai" },
      { id: "openai/also-good", name: "Also Good", provider: "openai", variants: ["high"] },
    ]);
  });

  test("reports why a batch was rejected when no model in it is usable", async () => {
    await expect(
      invoke("cache_opencode_model_catalog", {
        projectId: "project-a",
        models: [
          { id: "openai/a", name: "A", provider: "openai", contextWindow: 1.5 },
          { id: "openai/b", name: "B", provider: "openai", inputCost: -1 },
        ],
      }),
    ).rejects.toThrow(
      /at least one model.*contextWindow to be a positive safe integer/s,
    );
  });

  test.each([
    ["missing project id", "get_opencode_model_catalog_cache", {}, "projectId"],
    ["blank project id", "get_opencode_model_catalog_cache", { projectId: " " }, "non-blank"],
    ["unexpected get argument", "get_opencode_model_catalog_cache", { projectId: "p", extra: true }, "Unexpected arguments field"],
    ["models is not an array", "cache_opencode_model_catalog", { projectId: "p", models: {} }, "models to be an array"],
    ["empty models", "cache_opencode_model_catalog", { projectId: "p", models: [] }, "at least one model"],
    ["model is not an object", "cache_opencode_model_catalog", { projectId: "p", models: [null] }, "models[0] to be an object"],
    ["unexpected model field", "cache_opencode_model_catalog", { projectId: "p", models: [{ id: "a", name: "A", provider: "p", extra: true }] }, "Unexpected models[0] field"],
    ["blank model id", "cache_opencode_model_catalog", { projectId: "p", models: [{ id: " ", name: "A", provider: "p" }] }, "models[0].id to be a non-blank string"],
    ["blank model name", "cache_opencode_model_catalog", { projectId: "p", models: [{ id: "a", name: " ", provider: "p" }] }, "models[0].name to be a non-blank string"],
    ["blank model provider", "cache_opencode_model_catalog", { projectId: "p", models: [{ id: "a", name: "A", provider: " " }] }, "models[0].provider to be a non-blank string"],
    ["variants is not an array", "cache_opencode_model_catalog", { projectId: "p", models: [{ id: "a", name: "A", provider: "p", variants: "fast" }] }, "variants to be an array"],
    ["non-string variant", "cache_opencode_model_catalog", { projectId: "p", models: [{ id: "a", name: "A", provider: "p", variants: [1] }] }, "variants[0] to be a string"],
    ["blank variant", "cache_opencode_model_catalog", { projectId: "p", models: [{ id: "a", name: "A", provider: "p", variants: [" "] }] }, "variants[0] to be a non-blank string"],
    ["negative input cost", "cache_opencode_model_catalog", { projectId: "p", models: [{ id: "a", name: "A", provider: "p", inputCost: -1 }] }, "inputCost to be non-negative"],
    ["infinite output cost", "cache_opencode_model_catalog", { projectId: "p", models: [{ id: "a", name: "A", provider: "p", outputCost: Number.POSITIVE_INFINITY }] }, "outputCost to be a number"],
    ["zero context", "cache_opencode_model_catalog", { projectId: "p", models: [{ id: "a", name: "A", provider: "p", contextWindow: 0 }] }, "contextWindow to be a positive safe integer"],
    ["fractional context", "cache_opencode_model_catalog", { projectId: "p", models: [{ id: "a", name: "A", provider: "p", contextWindow: 1.5 }] }, "contextWindow to be a positive safe integer"],
    ["unsafe context", "cache_opencode_model_catalog", { projectId: "p", models: [{ id: "a", name: "A", provider: "p", contextWindow: Number.MAX_SAFE_INTEGER + 1 }] }, "contextWindow to be a positive safe integer"],
    ["unexpected cache argument", "cache_opencode_model_catalog", { projectId: "p", models: [{ id: "a", name: "A", provider: "p" }], extra: true }, "Unexpected arguments field"],
  ] as const)("rejects malformed OpenCode catalogue command input: %s", async (
    _label,
    command,
    args,
    message,
  ) => {
    await expect(invoke(command, args)).rejects.toThrow(message);
  });

  test("stops the in-container Codex bridge without the pattern matching its own shell", async () => {
    await expect(invoke("stop_codex_server", { containerId: "container-a" })).resolves.toBeUndefined();

    const log = await readCommandLog();
    expect(log).toContain("pkill -f '[c]odex-bridge/dist/index.js' || true; rm -f /tmp/codex-bridge-token");
    expect(log).not.toContain("pkill -f 'codex-bridge'");
  });

  test("stops the in-container Claude bridge without the pattern matching its own shell", async () => {
    await expect(invoke("stop_claude_server", { containerId: "container-a" })).resolves.toBeUndefined();

    const log = await readCommandLog();
    expect(log).toContain("pkill -f '[c]laude-bridge/dist/index.js' || true; rm -f /tmp/claude-bridge-token");
    expect(log).not.toContain("pkill -f 'claude-bridge'");
  });

  test("omits the Codex auth token when the container token file is missing or malformed", async () => {
    const healthy = await startHealthyServer();
    process.env.FAKE_DOCKER_PORT = String(healthy.port);
    try {
      expect(await invoke("get_codex_server_status", { containerId: "container-a" })).toEqual({
        running: true,
        hostPort: healthy.port,
      });

      process.env.FAKE_CODEX_BRIDGE_TOKEN = "not-a-valid-token";
      expect(await invoke("get_codex_server_status", { containerId: "container-a" })).toEqual({
        running: true,
        hostPort: healthy.port,
      });
    } finally {
      await healthy.close();
    }
  });

  test("reports the Claude auth token from status only when it is well-formed", async () => {
    const healthy = await startHealthyServer();
    process.env.FAKE_DOCKER_PORT = String(healthy.port);
    try {
      expect(await invoke("get_claude_server_status", { containerId: "container-a" })).toEqual({
        running: true,
        hostPort: healthy.port,
      });

      process.env.FAKE_CLAUDE_BRIDGE_TOKEN = "not-a-valid-token";
      expect(await invoke("get_claude_server_status", { containerId: "container-a" })).toEqual({
        running: true,
        hostPort: healthy.port,
      });

      process.env.FAKE_CLAUDE_BRIDGE_TOKEN = "c".repeat(43);
      expect(await invoke("get_claude_server_status", { containerId: "container-a" })).toEqual({
        running: true,
        hostPort: healthy.port,
        authToken: "c".repeat(43),
      });
    } finally {
      await healthy.close();
    }
  });

  test("reports credentials and GitHub CLI availability from isolated filesystem state", async () => {
    expect(await invoke("has_claude_credentials")).toBe(false);
    expect(await invoke("get_credential_status")).toEqual({ available: false, expiresAt: null });
    expect(await invoke("check_claude_config")).toBe(false);
    expect(await invoke("check_github_cli")).toBe(true);

    await fs.mkdir(path.join(fakeHome, ".claude"), { recursive: true });
    await fs.writeFile(path.join(fakeHome, ".claude", ".credentials.json"), "{}");
    await fs.writeFile(path.join(fakeHome, ".claude.json"), "{}");
    expect(await invoke("has_claude_credentials")).toBe(true);
    expect(await invoke("get_credential_status")).toEqual({ available: true, expiresAt: null });
    expect(await invoke("check_claude_config")).toBe(true);
  });

  test("launches browser, file manager, and editors without a shell", async () => {
    await invoke("open_in_browser", { url: "https://example.com/path?q=one&next=two" });
    await expect(invoke("open_in_browser", { url: "file:///tmp/private" })).rejects.toThrow("Unsupported browser URL protocol");
    await invoke("reveal_in_file_manager", { path: "/tmp/project/file.ts" });
    await invoke("open_in_editor", { containerId: "container-a", editor: "cursor" });
    await invoke("open_in_editor", { containerId: "container-b", editor: "vscode" });
    await invoke("open_local_in_editor", { path: "/tmp/project", editor: "code" });

    const log = await readCommandLog();
    const browserLauncher = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
    expect(log).toContain(`${browserLauncher} https://example.com/path?q=one&next=two`);
    if (process.platform === "darwin") expect(log).toContain("open -R /tmp/project/file.ts");
    else if (process.platform === "win32") expect(log).toContain("explorer /select, /tmp/project/file.ts");
    else expect(log).toContain("xdg-open /tmp/project");
    expect(log).toContain("cursor --folder-uri vscode-remote://attached-container+636f6e7461696e65722d61/workspace");
    expect(log).toContain("code --folder-uri vscode-remote://attached-container+636f6e7461696e65722d62/workspace");
    expect(log).toContain("code /tmp/project");
  });

  test("resolves domains and validate_domains delegates to the same behavior", async () => {
    const resolved = await invoke("test_domain_resolution", { domains: ["localhost", "bad domain"] }) as Array<Record<string, unknown>>;
    expect(resolved[0]).toMatchObject({ domain: "localhost", valid: true, resolvable: true, error: null });
    expect(resolved[0]?.ips).toBeArray();
    expect((resolved[0]?.ips as string[]).length).toBeGreaterThan(0);
    expect(resolved[1]).toMatchObject({ domain: "bad domain", valid: true, resolvable: false, ips: [] });
    expect(resolved[1]?.error).toBeString();

    const delegated = await invoke("validate_domains", { domains: ["localhost"] }) as Array<Record<string, unknown>>;
    expect(delegated[0]).toMatchObject({ domain: "localhost", valid: true, resolvable: true, error: null });
  });
});

/**
 * Linear and looped-review commands. The Linear handlers are the only ones
 * here that reach an external service, so `fetch` is stubbed at the module
 * boundary: everything below it (auth gating, argument validation, GraphQL
 * response mapping and error sanitization) is the real implementation.
 */
describe("Linear and looped review command behavior", () => {
  const originalFetch = globalThis.fetch;

  type LinearAuth = { apiKey: string; viewer: { id: string; name: string } } | null;

  function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function issueNode(overrides: Record<string, unknown> = {}) {
    return {
      id: "issue-1",
      identifier: "ENG-1",
      title: "Ship the thing",
      updatedAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2025-12-01T00:00:00.000Z",
      url: "https://linear.app/acme/issue/ENG-1",
      priorityLabel: "Urgent",
      sortOrder: 1,
      state: { name: "In Progress", type: "started" },
      team: { key: "ENG", name: "Engineering" },
      assignee: { name: "Ada" },
      ...overrides,
    };
  }

  function createLinearContext(auth: LinearAuth) {
    const getLinearAuth = mock(async () => auth);
    const context = {
      appRoot: root,
      resourceRoot: root,
      emit: mock(() => {}),
      storage: { getLinearAuth },
    } as unknown as CommandContext;
    return { context, getLinearAuth };
  }

  function createWorkflowContext(workflows: Record<string, unknown>) {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const context = {
      appRoot: root,
      resourceRoot: root,
      emit: mock(() => {}),
      storage: {
        getLoopedReviewWorkflow: mock(async (workflowId: string) => {
          calls.push({ method: "get", args: [workflowId] });
          return workflows[workflowId] ?? null;
        }),
        listLoopedReviewWorkflows: mock(async (environmentId: string) => {
          calls.push({ method: "list", args: [environmentId] });
          return Object.values(workflows).filter(
            (workflow) =>
              (workflow as { environmentId?: string }).environmentId === environmentId,
          );
        }),
        deleteLoopedReviewWorkflow: mock(async (workflowId: string) => {
          calls.push({ method: "delete", args: [workflowId] });
          delete workflows[workflowId];
        }),
      },
    } as unknown as CommandContext;
    return { context, calls };
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("refuses Linear issue commands before an account is connected", async () => {
    const { context, getLinearAuth } = createLinearContext(null);
    const fetchMock = mock(async () => jsonResponse({ data: {} }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(invoke("get_linear_issues", {}, context)).rejects.toThrow(
      "Linear is not connected",
    );
    await expect(
      invoke("get_linear_issue", { issueId: "ENG-1" }, context),
    ).rejects.toThrow("Linear is not connected");

    // The auth gate runs before any network call.
    expect(getLinearAuth).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("lists Linear issues with the stored API key and paginates", async () => {
    const { context } = createLinearContext({
      apiKey: "lin_api_secret",
      viewer: { id: "viewer-1", name: "Ada" },
    });
    const requests: Array<{ headers: unknown; variables: Record<string, unknown> }> = [];
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        variables: Record<string, unknown>;
      };
      requests.push({ headers: init?.headers, variables: body.variables });
      if (requests.length === 1) {
        return jsonResponse({
          data: {
            issues: {
              nodes: [issueNode()],
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            },
          },
        });
      }
      return jsonResponse({
        data: {
          issues: {
            nodes: [issueNode({ id: "issue-2", identifier: "ENG-2", sortOrder: 2 })],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }) as unknown as typeof fetch;

    const issues = await invoke("get_linear_issues", {}, context) as Array<
      Record<string, unknown>
    >;

    expect(issues.map((issue) => issue.identifier)).toEqual(["ENG-1", "ENG-2"]);
    expect(issues[0]).toMatchObject({
      id: "issue-1",
      title: "Ship the thing",
      status: "In Progress",
      statusType: "started",
      teamKey: "ENG",
      assigneeName: "Ada",
      priorityLabel: "Urgent",
    });
    expect(requests[0]?.headers).toMatchObject({ Authorization: "lin_api_secret" });
    expect(requests[0]?.variables).toEqual({ after: null });
    expect(requests[1]?.variables).toEqual({ after: "cursor-1" });
  });

  test("sanitizes the API key out of a failed Linear issue list", async () => {
    const { context } = createLinearContext({
      apiKey: "lin_api_secret",
      viewer: { id: "viewer-1", name: "Ada" },
    });
    globalThis.fetch = mock(async () =>
      jsonResponse(
        { errors: [{ message: "Authentication failed for lin_api_secret" }] },
        401,
      ),
    ) as unknown as typeof fetch;

    const error = await invoke("get_linear_issues", {}, context).then(
      () => null,
      (reason: unknown) => reason as Error,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toContain("lin_api_secret");
    expect(error?.message).toContain("[redacted]");
  });

  test("fetches one Linear issue with its comments", async () => {
    const { context } = createLinearContext({
      apiKey: "lin_api_secret",
      viewer: { id: "viewer-1", name: "Ada" },
    });
    const variables: Array<Record<string, unknown>> = [];
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      variables.push(body.variables);
      if (body.query.includes("comments(")) {
        return jsonResponse({
          data: {
            issue: {
              comments: {
                nodes: [{
                  id: "comment-1",
                  body: "Looks good",
                  createdAt: "2026-01-02T00:00:00.000Z",
                  user: { name: "Grace" },
                }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      }
      return jsonResponse({
        data: {
          issue: issueNode({
            description: "Full description",
            creator: { name: "Ada" },
            project: { name: "Platform" },
            cycle: { name: "Cycle 4" },
            labels: { nodes: [{ name: "backend" }] },
          }),
        },
      });
    }) as unknown as typeof fetch;

    const issue = await invoke(
      "get_linear_issue",
      { issueId: "ENG-1" },
      context,
    ) as Record<string, unknown>;

    expect(issue).toMatchObject({
      id: "issue-1",
      identifier: "ENG-1",
      description: "Full description",
      creatorName: "Ada",
      projectName: "Platform",
      cycleName: "Cycle 4",
      labels: ["backend"],
    });
    expect(issue.comments).toMatchObject([{ id: "comment-1", body: "Looks good" }]);
    expect(variables[0]).toEqual({ id: "ENG-1" });
  });

  test("reports a missing Linear issue without leaking the API key", async () => {
    const { context } = createLinearContext({
      apiKey: "lin_api_secret",
      viewer: { id: "viewer-1", name: "Ada" },
    });
    globalThis.fetch = mock(async () =>
      jsonResponse({ data: { issue: null } }),
    ) as unknown as typeof fetch;

    await expect(
      invoke("get_linear_issue", { issueId: "ENG-404" }, context),
    ).rejects.toThrow("Linear issue not found: ENG-404");
  });

  test("validates the issueId argument of get_linear_issue", async () => {
    const { context } = createLinearContext({
      apiKey: "lin_api_secret",
      viewer: { id: "viewer-1", name: "Ada" },
    });
    const fetchMock = mock(async () => jsonResponse({ data: {} }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(invoke("get_linear_issue", { issueId: 7 }, context)).rejects.toThrow(
      "Expected issueId to be a string",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("reads, lists, and deletes looped review workflows through storage", async () => {
    const workflows: Record<string, unknown> = {
      "workflow-1": {
        version: 1,
        id: "workflow-1",
        environmentId: "environment-1",
        snapshot: { phase: "reviewing" },
        updatedAt: new Date(0).toISOString(),
        revision: 3,
      },
      "workflow-2": {
        version: 1,
        id: "workflow-2",
        environmentId: "environment-2",
        snapshot: { phase: "completed" },
        updatedAt: new Date(0).toISOString(),
        revision: 1,
      },
    };
    const { context, calls } = createWorkflowContext(workflows);

    expect(await invoke("get_looped_review_workflow", { workflowId: "workflow-1" }, context))
      .toMatchObject({ id: "workflow-1", revision: 3, snapshot: { phase: "reviewing" } });

    // Listing is environment-scoped: another environment's workflow is excluded.
    expect(
      await invoke(
        "list_looped_review_workflows",
        { environmentId: "environment-1" },
        context,
      ),
    ).toMatchObject([{ id: "workflow-1" }]);

    await invoke("delete_looped_review_workflow", { workflowId: "workflow-1" }, context);

    expect(await invoke("get_looped_review_workflow", { workflowId: "workflow-1" }, context))
      .toBeNull();
    expect(calls).toEqual([
      { method: "get", args: ["workflow-1"] },
      { method: "list", args: ["environment-1"] },
      // Deletion reads first so an active backend-owned workflow cannot be
      // removed without an explicit cancel transition.
      { method: "get", args: ["workflow-1"] },
      { method: "delete", args: ["workflow-1"] },
      { method: "get", args: ["workflow-1"] },
    ]);
  });

  test("returns nothing for an unknown looped review workflow or environment", async () => {
    const { context } = createWorkflowContext({});

    expect(await invoke("get_looped_review_workflow", { workflowId: "missing" }, context))
      .toBeNull();
    expect(
      await invoke("list_looped_review_workflows", { environmentId: "missing" }, context),
    ).toEqual([]);
    // Deleting an absent workflow is a no-op rather than an error.
    await invoke("delete_looped_review_workflow", { workflowId: "missing" }, context);
  });

  test("validates looped review workflow arguments", async () => {
    const { context, calls } = createWorkflowContext({});

    await expect(
      invoke("get_looped_review_workflow", { workflowId: 1 }, context),
    ).rejects.toThrow("Expected workflowId to be a string");
    await expect(
      invoke("list_looped_review_workflows", { environmentId: null }, context),
    ).rejects.toThrow("Expected environmentId to be a string");
    await expect(
      invoke("delete_looped_review_workflow", {}, context),
    ).rejects.toThrow("Expected workflowId to be a string");

    expect(calls).toEqual([]);
  });
});
