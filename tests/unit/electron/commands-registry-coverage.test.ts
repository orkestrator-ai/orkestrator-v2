import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { CommandContext } from "../../../apps/backend/src/core/commands";
import type { Environment } from "../../../apps/backend/src/core/models";
import { runCommand } from "../../../apps/backend/src/core/shell";
import { dockerOwnerNamespace } from "../../../apps/backend/src/core/docker-ownership";

const {
  createCommandRegistry,
  shutdownPrMonitorTracking,
} = await import("../../../apps/backend/src/core/commands");

type Registry = ReturnType<typeof createCommandRegistry>;
type Handler = NonNullable<ReturnType<Registry["get"]>>;

const originalPath = process.env.PATH;
const originalCommandLog = process.env.FAKE_COMMAND_LOG;
const originalDockerPort = process.env.FAKE_DOCKER_PORT;
const originalDockerPortMissing = process.env.FAKE_DOCKER_PORT_MISSING;
const originalOpenCodeToken = process.env.FAKE_OPENCODE_TOKEN;
const tempDirectories: string[] = [];
let fixtureRoot = "";
let binDirectory = "";
let commandLog = "";
let registry: Registry;
const REGISTRY_DATA_DIR = path.join(os.tmpdir(), "ork-command-registry-data");
const REGISTRY_DOCKER_OWNER = dockerOwnerNamespace(REGISTRY_DATA_DIR);

const DOCKER_SCRIPT = `#!/bin/sh
printf 'docker %s\n' "$*" >> "$FAKE_COMMAND_LOG"

if [ "$1" = "container" ] && [ "$2" = "prune" ]; then
  printf 'Deleted Containers:\\nold-container\\nTotal reclaimed space: 768MB\\n'
  exit 0
fi
if [ "$1" = "ps" ] && [ "$2" = "-a" ]; then
  case "$*" in
    *"{{json .}}"*)
      printf '%s\\n' \
        '{"ID":"assigned-container","Names":"runtime-assigned","Status":"Up 2 minutes","State":"running","Image":"orkestrator-v2:latest","Labels":"app=orkestrator-v2,orkestrator-owner=${REGISTRY_DOCKER_OWNER},environment-name=assigned"}' \
        '{"ID":"orphan-container","Names":"runtime-orphan","Status":"Exited (0)","State":"exited","Image":"orkestrator-v2:latest","Labels":"app=orkestrator-v2,orkestrator-owner=${REGISTRY_DOCKER_OWNER},environment-name=orphan"}'
      ;;
    *" -q "*) printf 'assigned-container\\norphan-container\\n' ;;
    *) printf 'assigned-container\\tassigned\\tapp=orkestrator-v2,orkestrator-owner=${REGISTRY_DOCKER_OWNER}\\norphan-container\\torphan\\tapp=orkestrator-v2,orkestrator-owner=${REGISTRY_DOCKER_OWNER}\\n' ;;
  esac
  exit 0
fi
if [ "$1" = "ps" ] && [ "$2" = "-q" ]; then
  printf 'assigned-container\\n'
  exit 0
fi
if [ "$1" = "images" ] && [ "$2" = "-q" ]; then
  printf 'image-a\\nimage-a\\nimage-b\\n'
  exit 0
fi
if [ "$1" = "inspect" ]; then
  case "$*" in
    *orkestrator-owner*)
      case "$*" in
        *foreign-container*) printf 'foreign-owner\trunning\n' ;;
        *) printf '${REGISTRY_DOCKER_OWNER}\trunning\n' ;;
      esac
      ;;
    *) printf 'running\n' ;;
  esac
  exit 0
fi
if [ "$1" = "port" ]; then
  [ "\${FAKE_DOCKER_PORT_MISSING:-}" = "1" ] && exit 1
  printf '0.0.0.0:%s\\n' "\${FAKE_DOCKER_PORT:-43123}"
  exit 0
fi
if [ "$1" = "exec" ]; then
  case "$*" in
    *opencode-server-password*) printf '%s' "\${FAKE_OPENCODE_TOKEN:-}" ;;
  esac
  exit 0
fi
if [ "$1" = "rm" ] && [ "$2" = "-f" ]; then
  exit 0
fi
exit 0
`;

const LAUNCHER_SCRIPT = `#!/bin/sh
printf '%s %s\n' "\${0##*/}" "$*" >> "$FAKE_COMMAND_LOG"
`;

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "environment-1",
    projectId: "project-1",
    name: "Environment",
    branch: "feature/registry-coverage",
    containerId: "assigned-container",
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

function contextWithStorage(
  storage: Record<string, unknown>,
  events: Array<{ event: string; payload: unknown }> = [],
): CommandContext {
  return {
    appRoot: fixtureRoot,
    resourceRoot: fixtureRoot,
    emit: mock((event: string, payload: unknown) => events.push({ event, payload })),
    storage: {
      getDataDir: () => REGISTRY_DATA_DIR,
      ...storage,
    },
  } as unknown as CommandContext;
}

async function invoke(
  name: string,
  args: Record<string, unknown>,
  context: CommandContext,
): Promise<unknown> {
  const handler = registry.get(name) as Handler | undefined;
  expect(handler).toBeDefined();
  return handler!(args, context);
}

async function createTempDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

async function commandLogContents(): Promise<string> {
  return fs.readFile(commandLog, "utf8").catch(() => "");
}

async function startHealthServer(): Promise<{
  port: number;
  requests: Array<{ url: string; authorization: string | null }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const server = http.createServer((request, response) => {
    requests.push({
      url: request.url ?? "",
      authorization: request.headers.authorization ?? null,
    });
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
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

beforeAll(async () => {
  fixtureRoot = await createTempDirectory("ork-command-registry-coverage-");
  binDirectory = path.join(fixtureRoot, "bin");
  commandLog = path.join(fixtureRoot, "commands.log");
  await fs.mkdir(binDirectory, { recursive: true });
  await fs.writeFile(path.join(binDirectory, "docker"), DOCKER_SCRIPT);
  await fs.chmod(path.join(binDirectory, "docker"), 0o755);
  for (const executable of ["open", "xdg-open", "explorer.exe"]) {
    await fs.writeFile(path.join(binDirectory, executable), LAUNCHER_SCRIPT);
    await fs.chmod(path.join(binDirectory, executable), 0o755);
  }
  process.env.PATH = `${binDirectory}${path.delimiter}${originalPath ?? ""}`;
  process.env.FAKE_COMMAND_LOG = commandLog;
});

beforeEach(async () => {
  registry = createCommandRegistry();
  await fs.writeFile(commandLog, "");
  delete process.env.FAKE_DOCKER_PORT;
  delete process.env.FAKE_DOCKER_PORT_MISSING;
  delete process.env.FAKE_OPENCODE_TOKEN;
});

afterEach(() => {
  shutdownPrMonitorTracking();
  mock.restore();
});

afterAll(async () => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalCommandLog === undefined) delete process.env.FAKE_COMMAND_LOG;
  else process.env.FAKE_COMMAND_LOG = originalCommandLog;
  if (originalDockerPort === undefined) delete process.env.FAKE_DOCKER_PORT;
  else process.env.FAKE_DOCKER_PORT = originalDockerPort;
  if (originalDockerPortMissing === undefined) delete process.env.FAKE_DOCKER_PORT_MISSING;
  else process.env.FAKE_DOCKER_PORT_MISSING = originalDockerPortMissing;
  if (originalOpenCodeToken === undefined) delete process.env.FAKE_OPENCODE_TOKEN;
  else process.env.FAKE_OPENCODE_TOKEN = originalOpenCodeToken;
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("direct backend command registry coverage", () => {
  test("reports Docker maintenance results and removes only unassigned containers", async () => {
    const assigned = environment();
    const context = contextWithStorage({
      loadEnvironments: mock(async () => [assigned]),
    });

    await expect(
      invoke("docker_system_prune", {}, context),
    ).resolves.toEqual({
      containersDeleted: 2,
      imagesDeleted: 0,
      networksDeleted: 0,
      volumesDeleted: 0,
      spaceReclaimed: 768_000_000 * 2,
    });
    await expect(invoke("get_docker_system_stats", {}, context)).resolves.toMatchObject({
      containersRunning: 1,
      containersTotal: 2,
      imagesTotal: 2,
    });
    await expect(invoke("get_orkestrator_containers", {}, context)).resolves.toEqual([
      {
        id: "assigned-container",
        name: "Environment",
        status: "Up 2 minutes",
        state: "running",
        image: "orkestrator-v2:latest",
        created: 0,
        environmentId: "environment-1",
        projectId: "project-1",
        isAssigned: true,
        cpuPercent: null,
      },
      {
        id: "orphan-container",
        name: "orphan",
        status: "Exited (0)",
        state: "exited",
        image: "orkestrator-v2:latest",
        created: 0,
        environmentId: null,
        projectId: null,
        isAssigned: false,
        cpuPercent: null,
      },
    ]);
    await expect(invoke("cleanup_orphaned_containers", {}, context)).resolves.toBe(1);

    const log = await commandLogContents();
    expect(log).toContain(
      `docker container prune -f --filter label=orkestrator-owner=${REGISTRY_DOCKER_OWNER}`,
    );
    expect(log).toContain(
      "docker container prune -f --filter label=app=orkestrator-v2 --filter label!=orkestrator-owner",
    );
    expect(log).not.toContain("docker system prune");
    expect(log).toContain("docker rm -f orphan-container");
    expect(log).not.toContain("docker rm -f assigned-container");
  });

  test("agent-test Docker cleanup never adopts or prunes ownerless containers", async () => {
    const context = contextWithStorage({ loadEnvironments: mock(async () => []) });
    context.strictDockerOwner = true;

    await expect(invoke("docker_system_prune", {}, context)).resolves.toMatchObject({
      containersDeleted: 1,
      spaceReclaimed: 768_000_000,
    });
    const log = await commandLogContents();
    expect(log).toContain(
      `docker container prune -f --filter label=orkestrator-owner=${REGISTRY_DOCKER_OWNER}`,
    );
    expect(log).not.toContain("label!=orkestrator-owner");
  });

  test("agent-test container commands reject foreign ownership before reads or execution", async () => {
    const context = contextWithStorage({});
    context.strictDockerOwner = true;

    for (const [command, args] of [
      ["get_container_logs", { containerId: "foreign-container" }],
      ["start_codex_server", { containerId: "foreign-container" }],
      ["create_terminal_session", { containerId: "foreign-container", cols: 80, rows: 24 }],
      ["read_container_file", { containerId: "foreign-container", filePath: "README.md" }],
    ] as const) {
      await expect(invoke(command, args, context)).rejects.toThrow(
        "not owned by this development profile",
      );
    }

    const log = await commandLogContents();
    expect(log.match(/docker inspect/g)).toHaveLength(4);
    expect(log).not.toContain("docker logs");
    expect(log).not.toContain("docker exec");

    await expect(invoke(
      "get_container_logs",
      { containerId: "assigned-container" },
      context,
    )).resolves.toBe("");
    expect(await commandLogContents()).toContain("docker logs --tail 200 assigned-container");
  });

  test("the ownership wrapper costs nothing outside an agent-test profile", async () => {
    // The wrapper sits in front of *every* command carrying a containerId,
    // including ones the renderer polls. Without the strict-mode guard each of
    // those would pay for an extra `docker inspect` round trip in production.
    const context = contextWithStorage({});
    expect(context.strictDockerOwner).toBeFalsy();

    await expect(invoke(
      "get_container_logs",
      { containerId: "foreign-container" },
      context,
    )).resolves.toBe("");

    const log = await commandLogContents();
    expect(log).not.toContain("docker inspect");
    expect(log).toContain("docker logs --tail 200 foreign-container");
  });

  test("stops each bridge, reports authenticated OpenCode health, and delegates model caching", async () => {
    const cached = {
      schemaVersion: 2,
      projectId: "project-1",
      catalogVersion: "v1",
      updatedAt: "2026-07-29T00:00:00.000Z",
      models: [
        { id: "opencode/cached", name: "Cached", provider: "opencode" },
        // Excluded by the default allowlist, so the read must drop it.
        { id: "hpc-ai/flood", name: "Flood", provider: "hpc-ai" },
      ],
    };
    const getOpenCodeModelCatalog = mock(async () => cached);
    const cacheOpenCodeModelCatalog = mock(async (_projectId: string, models: unknown[]) => ({
      ...cached,
      models,
    }));
    const cachedAgents = {
      schemaVersion: 1 as const,
      codex: {
        updatedAt: "2026-07-29T00:00:00.000Z",
        models: [{ id: "gpt-cached", name: "GPT Cached" }],
      },
    };
    const getAgentModelCatalogCache = mock(async () => cachedAgents);
    const cacheAgentModelCatalog = mock(async (_agent: string, _models: unknown[]) =>
      cachedAgents
    );
    const context = contextWithStorage({
      getOpenCodeModelCatalog,
      cacheOpenCodeModelCatalog,
      getAgentModelCatalogCache,
      cacheAgentModelCatalog,
      // The cached-catalogue read filters by the configured OpenCode providers.
      loadConfig: mock(async () => ({ global: {} })),
    });

    for (const bridge of ["opencode", "claude", "codex"]) {
      await expect(
        invoke(`stop_${bridge}_server`, { containerId: "assigned-container" }, context),
      ).resolves.toBeUndefined();
    }

    process.env.FAKE_DOCKER_PORT_MISSING = "1";
    for (const bridge of ["opencode", "claude", "codex"]) {
      await expect(
        invoke(`get_${bridge}_server_status`, { containerId: "assigned-container" }, context),
      ).resolves.toEqual({ running: false, hostPort: null });
    }
    delete process.env.FAKE_DOCKER_PORT_MISSING;

    const health = await startHealthServer();
    process.env.FAKE_DOCKER_PORT = String(health.port);
    process.env.FAKE_OPENCODE_TOKEN = "t".repeat(43);
    try {
      await expect(
        invoke("get_opencode_server_status", { containerId: "assigned-container" }, context),
      ).resolves.toEqual({
        running: true,
        hostPort: health.port,
        authToken: "t".repeat(43),
      });
      expect(health.requests).toContainEqual({
        url: "/global/health",
        authorization: `Basic ${Buffer.from(`opencode:${"t".repeat(43)}`).toString("base64")}`,
      });
    } finally {
      await health.close();
    }

    await expect(
      invoke("get_opencode_model_catalog_cache", { projectId: " project-1 " }, context),
    ).resolves.toEqual({
      ...cached,
      models: [{ id: "opencode/cached", name: "Cached", provider: "opencode" }],
    });
    // Writes stay the complete durable record; only the reads narrow.
    const models = [{ id: "opencode/gpt-5", name: "GPT-5", provider: "opencode" }];
    await expect(
      invoke("cache_opencode_model_catalog", { projectId: "project-1", models }, context),
    ).resolves.toEqual({ ...cached, models });
    expect(getOpenCodeModelCatalog).toHaveBeenCalledWith("project-1");
    expect(cacheOpenCodeModelCatalog).toHaveBeenCalledWith("project-1", models);
    await expect(
      invoke("get_agent_model_catalog_cache", {}, context),
    ).resolves.toEqual(cachedAgents);
    await expect(
      invoke(
        "cache_agent_model_catalog",
        {
          agent: "codex",
          models: [{
            id: "gpt-cached",
            name: "GPT Cached",
            reasoningEfforts: ["medium", "ultra"],
            defaultReasoningEffort: "medium",
          }],
        },
        context,
      ),
    ).resolves.toEqual(cachedAgents);
    expect(cacheAgentModelCatalog).toHaveBeenCalledWith("codex", [{
      id: "gpt-cached",
      name: "GPT Cached",
      reasoningEfforts: ["medium", "ultra"],
      defaultReasoningEffort: "medium",
    }]);

    const log = await commandLogContents();
    expect(log).toContain("pkill -f '[o]pencode serve'");
    expect(log).toContain("pkill -f '[c]laude-bridge/dist/index.js'");
    expect(log).toContain("pkill -f '[c]odex-bridge/dist/index.js'");
  });

  test("persists the whole live OpenCode catalogue while narrowing only its response", async () => {
    const liveModels = [
      {
        platform: "opencode",
        id: "opencode/claude-sonnet-5",
        label: "Claude Sonnet 5",
        providerLabel: "OpenCode",
        reasoning: [{ id: "default", label: "Default" }],
        defaultReasoningId: "default",
        supportsSpeed: false,
        supportsMode: true,
      },
      {
        platform: "opencode",
        id: "openrouter/kimi-k2.5",
        label: "Kimi K2.5",
        providerLabel: "OpenRouter",
        reasoning: [{ id: "default", label: "Default" }],
        defaultReasoningId: "default",
        supportsSpeed: false,
        supportsMode: true,
      },
    ];
    const cacheOpenCodeModelCatalog = mock(async (_projectId: string, models: unknown[]) => ({
      schemaVersion: 2,
      projectId: "project-1",
      catalogVersion: "v2",
      updatedAt: "2026-08-14T00:00:00.000Z",
      models,
    }));
    const context = contextWithStorage({
      getEnvironment: mock(async () => ({
        id: "env-1",
        projectId: "project-1",
        environmentType: "containerized",
        containerId: "assigned-container",
      })),
      getAgentModelCatalogCache: mock(async () => ({ schemaVersion: 1 as const })),
      getOpenCodeModelCatalog: mock(async () => null),
      cacheOpenCodeModelCatalog,
      loadConfig: mock(async () => ({
        global: { openCodeModelProviders: ["opencode"] },
      })),
    });
    (context as unknown as { nativeAgents: unknown }).nativeAgents = {
      // The real service uses the provider's backend-only raw catalogue here;
      // picker responses remain filtered below in the command.
      listModelCatalogForCache: mock(async () => liveModels),
    };

    const health = await startHealthServer();
    process.env.FAKE_DOCKER_PORT = String(health.port);
    process.env.FAKE_OPENCODE_TOKEN = "t".repeat(43);
    try {
      const models = await invoke(
        "get_native_agent_model_catalog",
        { environmentId: "env-1" },
        context,
      ) as Array<{ id: string }>;

      // The response is narrowed to the configured provider...
      expect(models.map((model) => model.id)).toEqual(["opencode/claude-sonnet-5"]);
    } finally {
      delete process.env.FAKE_DOCKER_PORT;
      delete process.env.FAKE_OPENCODE_TOKEN;
      await health.close();
    }

    // ...but the durable cache keeps every provider the server reported.
    // Persisting the narrowed list would make the allowlist durable, so
    // re-adding `openrouter` later would leave the launch dialogs — which read
    // this cache before any OpenCode server is ready — missing it until an
    // environment happened to run and re-list.
    expect(cacheOpenCodeModelCatalog).toHaveBeenCalledTimes(1);
    const [, persisted] = cacheOpenCodeModelCatalog.mock.calls[0]!;
    expect((persisted as Array<{ id: string }>).map((model) => model.id)).toEqual([
      "opencode/claude-sonnet-5",
      "openrouter/kimi-k2.5",
    ]);
  });

  test("validates and delegates host agent model catalogue writes", async () => {
    const cachedAgents = { schemaVersion: 1 as const };
    const cacheAgentModelCatalog = mock(async () => cachedAgents);
    const context = contextWithStorage({ cacheAgentModelCatalog });
    const claudeModels = [{
      id: "claude-opus-latest",
      name: "Claude Opus Latest",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high"],
    }];

    await expect(
      invoke(
        "cache_agent_model_catalog",
        { agent: "claude", models: claudeModels },
        context,
      ),
    ).resolves.toEqual(cachedAgents);
    expect(cacheAgentModelCatalog).toHaveBeenCalledWith("claude", claudeModels);

    await expect(
      invoke(
        "cache_agent_model_catalog",
        { agent: "unsupported", models: claudeModels },
        context,
      ),
    ).rejects.toThrow("Expected agent to be claude or codex");
    await expect(
      invoke(
        "cache_agent_model_catalog",
        { agent: "claude", models: [] },
        context,
      ),
    ).rejects.toThrow("empty model catalog");
    await expect(
      invoke(
        "cache_agent_model_catalog",
        { agent: "claude", models: [{ id: "claude-opus-latest" }] },
        context,
      ),
    ).rejects.toThrow("without an id or name");
    await expect(
      invoke(
        "cache_agent_model_catalog",
        {
          agent: "codex",
          models: [{
            id: "gpt-latest",
            name: "GPT Latest",
            reasoningOptions: [{ effort: "impossible", label: "Invalid" }],
          }],
        },
        context,
      ),
    ).rejects.toThrow("supported reasoning effort");
    await expect(
      invoke(
        "cache_agent_model_catalog",
        {
          agent: "codex",
          models: [{
            id: "gpt-latest",
            name: "GPT Latest",
            reasoningEfforts: ["medium", "impossible"],
          }],
        },
        context,
      ),
    ).rejects.toThrow("supported reasoning effort");
    await expect(
      invoke(
        "cache_agent_model_catalog",
        {
          agent: "codex",
          models: [{
            id: "gpt-latest",
            name: "GPT Latest",
            defaultReasoningEffort: "impossible",
          }],
        },
        context,
      ),
    ).rejects.toThrow("supported reasoning effort");
    await expect(
      invoke(
        "cache_agent_model_catalog",
        {
          agent: "claude",
          models: [{
            id: "claude-opus-latest",
            name: "Claude Opus Latest",
            description: 42,
          }],
        },
        context,
      ),
    ).resolves.toEqual(cachedAgents);
    expect(cacheAgentModelCatalog).toHaveBeenLastCalledWith("claude", [
      expect.objectContaining({
        id: "claude-opus-latest",
        name: "Claude Opus Latest",
        description: undefined,
      }),
    ]);
    await expect(
      invoke(
        "cache_agent_model_catalog",
        {
          agent: "codex",
          models: [{ id: "gpt-latest", name: "GPT Latest", unexpected: true }],
        },
        context,
      ),
    ).rejects.toThrow(/[Uu]nexpected/);
    await expect(
      invoke(
        "cache_agent_model_catalog",
        { agent: "codex", models: [] },
        context,
      ),
    ).rejects.toThrow("at least one model");
    await expect(
      invoke(
        "cache_agent_model_catalog",
        { agent: "claude", models: claudeModels, extra: true },
        context,
      ),
    ).rejects.toThrow(/[Uu]nexpected/);

    expect(cacheAgentModelCatalog).toHaveBeenCalledTimes(2);
  });

  test("launches validated browser URLs and returns both DNS resolution outcomes", async () => {
    const context = contextWithStorage({});
    await expect(
      invoke("open_in_browser", { url: "https://example.com/a?x=1&y=2" }, context),
    ).resolves.toBeUndefined();
    await expect(
      invoke("open_in_browser", { url: "file:///tmp/private" }, context),
    ).rejects.toThrow("Unsupported browser URL protocol");

    const results = await invoke(
      "test_domain_resolution",
      { domains: ["localhost", "bad domain"] },
      context,
    ) as Array<Record<string, unknown>>;
    expect(results[0]).toMatchObject({
      domain: "localhost",
      valid: true,
      resolvable: true,
      error: null,
    });
    expect(results[1]).toMatchObject({
      domain: "bad domain",
      valid: true,
      resolvable: false,
      ips: [],
    });
    await expect(
      invoke("validate_domains", { domains: ["localhost"] }, context),
    ).resolves.toEqual([expect.objectContaining({
      domain: "localhost",
      resolvable: true,
    })]);

    const launcher = process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer.exe"
        : "xdg-open";
    expect(await commandLogContents()).toContain(
      `${launcher} https://example.com/a?x=1&y=2`,
    );
  });

  test("forwards storage reads and deletes with validated identifiers and revisions", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const value = (method: string, result: unknown) =>
      mock(async (...args: unknown[]) => {
        calls.push({ method, args });
        return result;
      });
    const context = contextWithStorage({
      loadSessionBuffer: value("loadSessionBuffer", "terminal output"),
      deletePaneLayout: value("deletePaneLayout", undefined),
      getPaneLayout: value("getPaneLayout", { revision: 3 }),
      getLoopedReviewWorkflow: value("getLoopedReviewWorkflow", {
        version: 2,
        id: "workflow-1",
        environmentId: "env-1",
        snapshot: { id: "workflow-1", phase: "preparing", controllerFence: "secret-fence" },
        updatedAt: "2026-08-03T00:00:00.000Z",
        revision: 7,
        controllerLease: {
          ownerId: "desktop",
          token: "secret-lease",
          expiresAt: "2026-08-03T00:01:00.000Z",
        },
      }),
      listLoopedReviewWorkflows: value("listLoopedReviewWorkflows", [{
        version: 2,
        id: "workflow-1",
        environmentId: "env-1",
        snapshot: { id: "workflow-1", phase: "preparing", controllerFence: "secret-fence" },
        updatedAt: "2026-08-03T00:00:00.000Z",
        revision: 7,
        controllerLease: {
          ownerId: "desktop",
          token: "secret-lease",
          expiresAt: "2026-08-03T00:01:00.000Z",
        },
      }]),
      deleteLoopedReviewWorkflow: value("deleteLoopedReviewWorkflow", undefined),
      getBuildPipeline: value("getBuildPipeline", { id: "pipeline-1" }),
      listBuildPipelines: value("listBuildPipelines", [{ id: "pipeline-1" }]),
      deleteBuildPipeline: value("deleteBuildPipeline", undefined),
      getPromptQueue: value("getPromptQueue", { queueKey: "queue-1" }),
      listPromptQueues: value("listPromptQueues", [{ queueKey: "queue-1" }]),
      enqueuePromptQueueMessage: value("enqueuePromptQueueMessage", { queueKey: "queue-1" }),
      requeuePromptQueueMessage: value("requeuePromptQueueMessage", { queueKey: "queue-1" }),
      removePromptQueueMessage: value("removePromptQueueMessage", { removed: { id: "m1" } }),
      movePromptQueueMessage: value("movePromptQueueMessage", { queueKey: "queue-1" }),
      claimPromptQueueHead: value("claimPromptQueueHead", { claimed: { id: "m1" } }),
      acknowledgePromptQueueClaim: value("acknowledgePromptQueueClaim", { queueKey: "queue-1" }),
      rejectPromptQueueClaim: value("rejectPromptQueueClaim", { queueKey: "queue-1" }),
      transferPromptQueueMessageToComposeDraft: value(
        "transferPromptQueueMessageToComposeDraft",
        { removed: { id: "m1" } },
      ),
      getComposeDraft: value("getComposeDraft", { draftKey: "compose-1" }),
      listComposeDrafts: value("listComposeDrafts", [{ draftKey: "compose-1" }]),
      deleteComposeDraft: value("deleteComposeDraft", undefined),
      getFileDraft: value("getFileDraft", { draftKey: "file-1" }),
      deleteFileDraft: value("deleteFileDraft", undefined),
      getAgentHandoff: value("getAgentHandoff", { handoffId: "handoff-1" }),
      deleteAgentHandoff: value("deleteAgentHandoff", undefined),
      pruneAgentHandoffs: value("pruneAgentHandoffs", 2),
    });

    const cases: Array<{
      command: string;
      args: Record<string, unknown>;
      expected: unknown;
      call: { method: string; args: unknown[] };
    }> = [
      { command: "load_session_buffer", args: { sessionId: "session-1" }, expected: "terminal output", call: { method: "loadSessionBuffer", args: ["session-1"] } },
      { command: "get_pane_layout", args: { environmentId: "env-1" }, expected: { revision: 3 }, call: { method: "getPaneLayout", args: ["env-1"] } },
      { command: "delete_pane_layout", args: { environmentId: "env-1" }, expected: undefined, call: { method: "deletePaneLayout", args: ["env-1"] } },
      { command: "get_looped_review_workflow", args: { workflowId: "workflow-1" }, expected: {
        version: 2,
        id: "workflow-1",
        environmentId: "env-1",
        snapshot: { id: "workflow-1", phase: "preparing" },
        updatedAt: "2026-08-03T00:00:00.000Z",
        revision: 7,
      }, call: { method: "getLoopedReviewWorkflow", args: ["workflow-1"] } },
      { command: "list_looped_review_workflows", args: { environmentId: "env-1" }, expected: [{
        version: 2,
        id: "workflow-1",
        environmentId: "env-1",
        snapshot: { id: "workflow-1", phase: "preparing" },
        updatedAt: "2026-08-03T00:00:00.000Z",
        revision: 7,
      }], call: { method: "listLoopedReviewWorkflows", args: ["env-1"] } },
      { command: "get_build_pipeline", args: { pipelineId: "pipeline-1" }, expected: { id: "pipeline-1" }, call: { method: "getBuildPipeline", args: ["pipeline-1"] } },
      { command: "list_build_pipelines", args: { projectId: "project-1" }, expected: [{ id: "pipeline-1" }], call: { method: "listBuildPipelines", args: ["project-1"] } },
      { command: "delete_build_pipeline", args: { pipelineId: "pipeline-1" }, expected: undefined, call: { method: "deleteBuildPipeline", args: ["pipeline-1"] } },
      { command: "get_prompt_queue", args: { queueKey: "queue-1" }, expected: { queueKey: "queue-1" }, call: { method: "getPromptQueue", args: ["queue-1"] } },
      { command: "list_prompt_queues", args: { environmentId: "env-1" }, expected: [{ queueKey: "queue-1" }], call: { method: "listPromptQueues", args: ["env-1"] } },
      { command: "enqueue_prompt_queue_message", args: { queueKey: "queue-1", environmentId: "env-1", message: { id: "m1" } }, expected: { queueKey: "queue-1" }, call: { method: "enqueuePromptQueueMessage", args: ["queue-1", "env-1", { id: "m1" }] } },
      { command: "requeue_prompt_queue_message", args: { queueKey: "queue-1", environmentId: "env-1", message: { id: "m1" } }, expected: { queueKey: "queue-1" }, call: { method: "requeuePromptQueueMessage", args: ["queue-1", "env-1", { id: "m1" }] } },
      { command: "remove_prompt_queue_message", args: { queueKey: "queue-1", environmentId: "env-1", messageId: "m1" }, expected: { removed: { id: "m1" } }, call: { method: "removePromptQueueMessage", args: ["queue-1", "env-1", "m1"] } },
      { command: "move_prompt_queue_message", args: { queueKey: "queue-1", environmentId: "env-1", messageId: "m1", direction: "up" }, expected: { queueKey: "queue-1" }, call: { method: "movePromptQueueMessage", args: ["queue-1", "env-1", "m1", "up"] } },
      { command: "claim_prompt_queue_head", args: { queueKey: "queue-1", environmentId: "env-1", expectedMessageId: "m1" }, expected: { claimed: { id: "m1" } }, call: { method: "claimPromptQueueHead", args: ["queue-1", "env-1", "m1"] } },
      { command: "acknowledge_prompt_queue_claim", args: { queueKey: "queue-1", environmentId: "env-1", claimToken: "token-1" }, expected: { queueKey: "queue-1" }, call: { method: "acknowledgePromptQueueClaim", args: ["queue-1", "env-1", "token-1"] } },
      { command: "reject_prompt_queue_claim", args: { queueKey: "queue-1", environmentId: "env-1", claimToken: "token-1" }, expected: { queueKey: "queue-1" }, call: { method: "rejectPromptQueueClaim", args: ["queue-1", "env-1", "token-1"] } },
      { command: "transfer_prompt_queue_message_to_compose_draft", args: { queueKey: "queue-1", environmentId: "env-1", messageId: "m1", draftKey: "draft-1", ownerType: "environment", ownerId: "env-1", expectedDraftRevision: 2 }, expected: { removed: { id: "m1" } }, call: { method: "transferPromptQueueMessageToComposeDraft", args: ["queue-1", "env-1", "m1", "draft-1", "environment", "env-1", 2] } },
      // The optional revision must be forwarded as `undefined`, not coerced to
      // 0: a 0 would assert "no draft exists" against a slot that may hold one.
      { command: "transfer_prompt_queue_message_to_compose_draft", args: { queueKey: "queue-1", environmentId: "env-1", messageId: "m1", draftKey: "draft-1", ownerType: "environment", ownerId: "env-1" }, expected: { removed: { id: "m1" } }, call: { method: "transferPromptQueueMessageToComposeDraft", args: ["queue-1", "env-1", "m1", "draft-1", "environment", "env-1", undefined] } },
      { command: "get_compose_draft", args: { draftKey: "compose-1" }, expected: { draftKey: "compose-1" }, call: { method: "getComposeDraft", args: ["compose-1"] } },
      { command: "list_compose_drafts", args: { ownerType: "environment", ownerId: "env-1" }, expected: [{ draftKey: "compose-1" }], call: { method: "listComposeDrafts", args: ["environment", "env-1"] } },
      { command: "delete_compose_draft", args: { draftKey: "compose-1", expectedRevision: 7 }, expected: undefined, call: { method: "deleteComposeDraft", args: ["compose-1", 7] } },
      { command: "get_file_draft", args: { draftKey: "file-1" }, expected: { draftKey: "file-1" }, call: { method: "getFileDraft", args: ["file-1"] } },
      { command: "delete_file_draft", args: { draftKey: "file-1" }, expected: undefined, call: { method: "deleteFileDraft", args: ["file-1", undefined] } },
      { command: "get_agent_handoff", args: { handoffId: "handoff-1" }, expected: { handoffId: "handoff-1" }, call: { method: "getAgentHandoff", args: ["handoff-1"] } },
      { command: "delete_agent_handoff", args: { handoffId: "handoff-1", environmentId: "env-1" }, expected: undefined, call: { method: "deleteAgentHandoff", args: ["handoff-1", "env-1"] } },
      { command: "prune_agent_handoffs", args: { environmentId: "env-1", referencedHandoffIds: ["keep-1"] }, expected: 2, call: { method: "pruneAgentHandoffs", args: ["env-1", ["keep-1"]] } },
    ];

    for (const item of cases) {
      await expect(invoke(item.command, item.args, context)).resolves.toEqual(item.expected);
      expect(calls.at(-1)).toEqual(item.call);
    }
    await expect(
      invoke(
        "prune_agent_handoffs",
        { environmentId: "env-1", referencedHandoffIds: "keep-1" },
        context,
      ),
    ).rejects.toThrow("Expected referencedHandoffIds to be an array");
  });

  test("deleting a looped review is gated on the stored version, not on whether the snapshot parses", async () => {
    const deleteLoopedReviewWorkflow = mock(async () => undefined);
    const withRecord = (record: unknown) => contextWithStorage({
      getLoopedReviewWorkflow: mock(async () => record),
      deleteLoopedReviewWorkflow,
    });

    // A backend-owned record whose snapshot does not parse is the one most
    // likely to still have a live supervisor driving it. Gating on the parsed
    // phase would fail open here and delete it out from under that supervisor.
    await expect(invoke("delete_looped_review_workflow", { workflowId: "workflow-1" }, withRecord({
      version: 2, id: "workflow-1", environmentId: "env-1", revision: 7,
      updatedAt: "2026-08-03T00:00:00.000Z",
      snapshot: { id: "workflow-1", phase: "preparing" },
    }))).rejects.toThrow("must be cancelled before deletion");
    expect(deleteLoopedReviewWorkflow).not.toHaveBeenCalled();

    // A legacy record was never backend-owned, so it stays deletable.
    await expect(invoke("delete_looped_review_workflow", { workflowId: "workflow-1" }, withRecord({
      version: 1, id: "workflow-1", environmentId: "env-1", revision: 7,
      updatedAt: "2026-08-03T00:00:00.000Z",
      snapshot: { id: "workflow-1", phase: "preparing" },
    }))).resolves.toBeUndefined();
    expect(deleteLoopedReviewWorkflow).toHaveBeenCalledTimes(1);

    // So does a record that no longer exists at all.
    await expect(invoke("delete_looped_review_workflow", { workflowId: "workflow-1" }, withRecord(null)))
      .resolves.toBeUndefined();
    expect(deleteLoopedReviewWorkflow).toHaveBeenCalledTimes(2);
  });

  test("deleting a multi review is gated on the stored phase being terminal", async () => {
    const deleteMultiReviewWorkflow = mock(async () => undefined);
    const record = (snapshot: unknown) => ({
      version: 1, id: "multi-1", environmentId: "env-1", revision: 4,
      updatedAt: "2026-08-14T00:00:00.000Z", snapshot,
    });
    const workflow = (phase: string) => ({
      version: 1, controller: "backend", id: "multi-1", environmentId: "env-1",
      projectId: "project-1", targetBranch: "main", phase,
      ...(phase === "cancelling" ? { cancellingSince: "2026-08-14T00:00:00.000Z" } : {}),
      reviewers: [{ id: "reviewer-1", agent: "claude", model: "opus", status: "cancelled" }],
      fixModel: { agent: "claude", model: "opus" },
      createdAt: "2026-08-14T00:00:00.000Z", updatedAt: "2026-08-14T00:00:00.000Z",
      backendRevision: 4,
    });
    const withRecord = (value: unknown) => contextWithStorage({
      getMultiReviewWorkflow: mock(async () => value),
      deleteMultiReviewWorkflow,
    });

    // A live supervisor may still be driving anything non-terminal, including
    // a cancellation that has been requested but has not finished aborting its
    // provider sessions yet. This is the case the launch rollback depends on.
    for (const phase of ["reviewing", "consolidating", "cancelling", "failed"]) {
      await expect(invoke("delete_multi_review_workflow", { workflowId: "multi-1" }, withRecord(record(workflow(phase)))))
        .rejects.toThrow("must be cancelled before deletion");
    }
    // A snapshot that does not parse is the one most likely to still be owned,
    // so it fails closed rather than being deleted out from under the backend.
    await expect(invoke("delete_multi_review_workflow", { workflowId: "multi-1" }, withRecord(record({ phase: "cancelled" }))))
      .rejects.toThrow("must be cancelled before deletion");
    expect(deleteMultiReviewWorkflow).not.toHaveBeenCalled();

    await expect(invoke("delete_multi_review_workflow", { workflowId: "multi-1" }, withRecord(record(workflow("cancelled")))))
      .resolves.toBeUndefined();
    // So does a record that no longer exists at all.
    await expect(invoke("delete_multi_review_workflow", { workflowId: "multi-1" }, withRecord(null)))
      .resolves.toBeUndefined();
    expect(deleteMultiReviewWorkflow).toHaveBeenCalledTimes(2);
    await expect(invoke("delete_multi_review_workflow", { workflowId: " " }, withRecord(null)))
      .rejects.toThrow("non-blank string");
  });

  test("admits stable container terminal sessions without starting a PTY", async () => {
    const assigned = environment();
    const loadEnvironments = mock(async () => [assigned]);
    const context = contextWithStorage({ loadEnvironments });
    const args = {
      containerId: "assigned-container",
      environmentId: "environment-1",
      terminalKey: "shell",
      cols: 100,
      rows: 30,
      user: "node",
      trackEnvironmentActivity: true,
    };

    const first = await invoke("create_terminal_session", args, context) as {
      sessionId: string;
      created: boolean;
    };
    const second = await invoke("create_terminal_session", args, context);
    expect(first.created).toBe(true);
    expect(first.sessionId).toStartWith("assigned-container:");
    expect(second).toEqual({ sessionId: first.sessionId, created: false, bootstrapped: false });
    expect(await invoke(
      "get_terminal_session",
      { sessionId: first.sessionId },
      context,
    )).toEqual({ id: first.sessionId, running: false, bootstrapped: false });
    expect(await invoke(
      "get_terminal_output_snapshot",
      { sessionId: first.sessionId },
      context,
    )).toEqual({
      output: "",
      revision: 0,
      generation: 1,
      truncated: false,
    });

    await expect(
      invoke("create_terminal_session", {
        ...args,
        containerId: "unassigned-container",
      }, context),
    ).rejects.toThrow("Terminal container is not associated with the requested environment");
    await invoke("detach_terminal", { sessionId: first.sessionId }, context);
  });

  test("reads, reverts, and deletes local worktree files through environment-scoped handlers", async () => {
    const worktree = await createTempDirectory("ork-command-local-files-");
    await runCommand("git", ["init", "-b", "main"], { cwd: worktree });
    await runCommand("git", ["config", "user.email", "tests@example.invalid"], { cwd: worktree });
    await runCommand("git", ["config", "user.name", "Tests"], { cwd: worktree });
    await fs.mkdir(path.join(worktree, "src"));
    await fs.writeFile(path.join(worktree, "src", "app.ts"), "export const value = 1;\n");
    await fs.writeFile(path.join(worktree, "delete-me.txt"), "delete me\n");
    await runCommand("git", ["add", "."], { cwd: worktree });
    await runCommand("git", ["commit", "-m", "fixture"], { cwd: worktree });
    await fs.writeFile(path.join(worktree, "src", "app.ts"), "export const value = 2;\n");

    const local = environment({
      environmentType: "local",
      containerId: null,
      worktreePath: worktree,
    });
    const context = contextWithStorage({
      getEnvironment: mock(async (id: string) => id === local.id ? local : null),
    });

    await expect(
      invoke("read_local_file", { worktreePath: worktree, filePath: "src/app.ts" }, context),
    ).resolves.toEqual({
      path: "src/app.ts",
      content: "export const value = 2;\n",
      language: "typescript",
    });
    await expect(
      invoke("read_local_file_at_branch", {
        worktreePath: worktree,
        filePath: "src/app.ts",
        branch: "main",
      }, context),
    ).resolves.toEqual({
      path: "src/app.ts",
      content: "export const value = 1;\n",
      language: "typescript",
    });
    await expect(
      invoke("revert_local_file", {
        environmentId: local.id,
        filePath: "src/app.ts",
        targetBranch: "main",
      }, context),
    ).resolves.toBe("src/app.ts");
    expect(await fs.readFile(path.join(worktree, "src", "app.ts"), "utf8"))
      .toBe("export const value = 1;\n");

    await expect(
      invoke("delete_local_file", {
        environmentId: local.id,
        filePath: "delete-me.txt",
      }, context),
    ).resolves.toBe("delete-me.txt");
    expect(await fs.stat(path.join(worktree, "delete-me.txt")).then(
      () => true,
      () => false,
    )).toBe(false);
    await expect(
      invoke("delete_local_file", {
        environmentId: local.id,
        filePath: "../outside.txt",
      }, context),
    ).rejects.toThrow("parent directory traversal is not allowed");
  });

  test("records paused PR watch intent, refreshes safely, and validates modes", async () => {
    const paused = environment({
      environmentType: "local",
      containerId: null,
      worktreePath: null,
      status: "stopped",
    });
    const events: Array<{ event: string; payload: unknown }> = [];
    const context = contextWithStorage({
      loadEnvironments: mock(async () => [paused]),
      getEnvironment: mock(async (id: string) => id === paused.id ? paused : null),
    }, events);

    await expect(
      invoke("pr_monitor_watch", {
        environmentId: paused.id,
        mode: "create-pending",
      }, context),
    ).resolves.toBeUndefined();
    const state = await invoke("get_pr_monitor_state", {}, context) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(state.entries).toEqual([
      expect.objectContaining({
        environmentId: paused.id,
        mode: "create-pending",
        checkInProgress: false,
      }),
    ]);
    await expect(
      invoke("pr_monitor_refresh", { environmentId: paused.id }, context),
    ).resolves.toBeUndefined();
    // A paused target cannot schedule external work; refresh preserves the
    // durable request until the environment becomes ready.
    expect((await invoke("get_pr_monitor_state", {}, context) as {
      entries: Array<Record<string, unknown>>;
    }).entries[0]).toMatchObject({
      environmentId: paused.id,
      mode: "create-pending",
      checkInProgress: false,
    });

    await expect(
      invoke("pr_monitor_watch", {
        environmentId: paused.id,
        mode: "immediately",
      }, context),
    ).rejects.toThrow("mode must be normal, create-pending, or merge-pending");
    await expect(
      invoke("pr_monitor_watch", {
        environmentId: "missing",
        mode: "normal",
      }, context),
    ).rejects.toThrow("Environment not found: missing");
  });

  test("delegates feature build claims and preserves storage conflict results", async () => {
    const claimFeaturePlanBuild = mock(async (featureId: string, taskId: string) => ({
      claimed: taskId === "task-winner",
      feature: {
        id: featureId,
        status: "building",
        buildTaskId: "task-winner",
      },
    }));
    const context = contextWithStorage({ claimFeaturePlanBuild });

    await expect(
      invoke("claim_feature_plan_build", {
        featureId: "feature-1",
        taskId: "task-winner",
      }, context),
    ).resolves.toMatchObject({ claimed: true });
    await expect(
      invoke("claim_feature_plan_build", {
        featureId: "feature-1",
        taskId: "task-loser",
      }, context),
    ).resolves.toMatchObject({
      claimed: false,
      feature: { buildTaskId: "task-winner" },
    });
    expect(claimFeaturePlanBuild).toHaveBeenNthCalledWith(
      1,
      "feature-1",
      "task-winner",
    );
    expect(claimFeaturePlanBuild).toHaveBeenNthCalledWith(
      2,
      "feature-1",
      "task-loser",
    );
    await expect(
      invoke("claim_feature_plan_build", {
        featureId: "feature-1",
        taskId: 7,
      }, context),
    ).rejects.toThrow("Expected taskId to be a string");
  });
});
