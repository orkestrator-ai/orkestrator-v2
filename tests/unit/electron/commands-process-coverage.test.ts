import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { CommandContext } from "../../../apps/backend/src/core/commands";
import type { Environment } from "../../../apps/backend/src/core/models";

const { createCommandRegistry } = await import("../../../apps/backend/src/core/commands");

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

async function startHealthyServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200);
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
    try {
      expect(await invoke("start_codex_server", { containerId: "container-a" })).toEqual({
        hostPort: healthy.port,
        wasRunning: true,
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
    await invoke("open_local_in_editor", { path: "/tmp/project", editor: "code" });

    const log = await readCommandLog();
    const browserLauncher = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
    expect(log).toContain(`${browserLauncher} https://example.com/path?q=one&next=two`);
    if (process.platform === "darwin") expect(log).toContain("open -R /tmp/project/file.ts");
    else if (process.platform === "win32") expect(log).toContain("explorer /select, /tmp/project/file.ts");
    else expect(log).toContain("xdg-open /tmp/project");
    expect(log).toContain("cursor vscode-remote://attached-container+636f6e7461696e65722d61/workspace");
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
