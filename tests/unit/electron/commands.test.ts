import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { execFile, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  isPaneLayoutRevisionConflict,
  paneLayoutRevisionConflictMessage,
} from "@orkestrator/protocol/pane-layout";
import { spawnCommand } from "../../../apps/backend/src/core/shell";
import type { Environment, RepositoryConfig } from "../../../apps/backend/src/core/models";
import type { CommandContext } from "../../../apps/backend/src/core/commands";
import { APP_SLUG, APP_VERSION } from "../../../apps/backend/src/core/constants";
import { EnvironmentLifecycleTaskTracker } from "../../../apps/backend/src/core/environment-lifecycle-tasks";

const execFileAsync = promisify(execFile);
const liveDockerTest = process.env.RUN_LIVE_DOCKER_TESTS === "1" ? test : test.skip;

const showOpenDialog = mock(async () => ({ canceled: false, filePaths: ["/tmp/project"] }));
mock.module("electron", () => ({
  dialog: { showOpenDialog },
  shell: {
    openExternal: mock(async () => undefined),
    showItemInFolder: mock(() => undefined),
  },
}));

type MockPtyProcess = {
  write: ReturnType<typeof mock>;
  resize: ReturnType<typeof mock>;
  kill: ReturnType<typeof mock>;
  emitData: (data: string) => void;
  emitExit: (event?: { exitCode: number; signal?: number }) => void;
};

type PtyExitEvent = { exitCode: number; signal?: number };

const ptyProcesses: MockPtyProcess[] = [];
const ptySpawn = mock((command: string, args: string[], options: Record<string, unknown>) => {
  const dataCallbacks: Array<(data: string) => void> = [];
  const exitCallbacks: Array<(event: PtyExitEvent) => void> = [];
  const process: MockPtyProcess = {
    write: mock(() => undefined),
    resize: mock(() => undefined),
    kill: mock(() => undefined),
    emitData: (data: string) => dataCallbacks.forEach((callback) => callback(data)),
    emitExit: (event = { exitCode: 0 }) => exitCallbacks.forEach((callback) => callback(event)),
  };
  const ptyProcess = {
    pid: ptyProcesses.length + 1,
    cols: Number(options.cols ?? 80),
    rows: Number(options.rows ?? 24),
    process: command,
    handleFlowControl: false,
    onData: mock((callback: (data: string) => void) => {
      dataCallbacks.push(callback);
      return { dispose: mock(() => undefined) };
    }),
    onExit: mock((callback: () => void) => {
      exitCallbacks.push(callback);
      return { dispose: mock(() => undefined) };
    }),
    resize: process.resize,
    clear: mock(() => undefined),
    write: process.write,
    kill: process.kill,
    pause: mock(() => undefined),
    resume: mock(() => undefined),
  };
  ptyProcesses.push(process);
  return ptyProcess;
});

mock.module("../../../apps/backend/src/core/pty", () => ({ spawnPty: ptySpawn }));

const {
  __testing: commandTesting,
  closeLocalServerAdmission,
  CONTAINER_UNTRACKED_STATS_SCANNER,
  createCommandRegistry,
  ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES,
  isImmutableCommitRef,
  resolveBrowserOpenCommand,
  shutdownDiffStatsTracking,
  shutdownLocalServers,
  shutdownPrMonitorTracking,
  toClientEnvironment,
} = await import("../../../apps/backend/src/core/commands");
const { CommandFailedError } = await import("../../../apps/backend/src/core/shell");

const tempDirs: string[] = [];
const SETUP_DONE_OSC = "\u001b]9999;setup_done\u0007";
const SETUP_FAILED_OSC = "\u001b]9999;setup_failed\u0007";
const TERMINAL_ACTIVITY_SETTLE_TEST_WAIT_MS = 850;

function terminalSessionResult(value: unknown): { sessionId: string; created: boolean } {
  return value as { sessionId: string; created: boolean };
}

function framedContainerGitStatus(
  nameStatus = "",
  numstat = "",
  untracked = "",
): string {
  return [
    "\u001eORKESTRATOR_NAME_STATUS\u001f",
    Buffer.from(nameStatus).toString("base64"),
    "\u001eORKESTRATOR_NUMSTAT\u001f",
    Buffer.from(numstat).toString("base64"),
    "\u001eORKESTRATOR_UNTRACKED\u001f",
    Buffer.from(untracked).toString("base64"),
    "\u001eORKESTRATOR_END\u001f",
  ].join("");
}

describe("resolveBrowserOpenCommand", () => {
  test("uses direct platform launchers without a command interpreter", () => {
    expect(resolveBrowserOpenCommand("https://example.com/a?x=1&y=2", "darwin")).toEqual({
      command: "open",
      args: ["https://example.com/a?x=1&y=2"],
    });
    expect(resolveBrowserOpenCommand("https://example.com/a?x=1&y=2", "win32")).toEqual({
      command: "explorer.exe",
      args: ["https://example.com/a?x=1&y=2"],
    });
    expect(resolveBrowserOpenCommand("http://127.0.0.1:34121/", "linux")).toEqual({
      command: "xdg-open",
      args: ["http://127.0.0.1:34121/"],
    });
  });

  test("rejects malformed and non-web URLs", () => {
    expect(() => resolveBrowserOpenCommand("not a url", "win32")).toThrow("Invalid browser URL");
    expect(() => resolveBrowserOpenCommand("file:///tmp/secret", "win32")).toThrow(
      "Unsupported browser URL protocol",
    );
  });
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function reserveFreePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("Failed to reserve a port"))));
    });
  });
}

function createEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-local",
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
    worktreePath: "/tmp/worktree",
    ...overrides,
  };
}

/**
 * Assert that an update issued to `StorageService.updateEnvironment` clears the
 * durable agent-launch intent along with both one-shot launch options.
 *
 * Asserting `toEqual({..., initialAgentModel: undefined})` would be vacuous:
 * Bun's `toEqual`/`toContainEqual` ignore properties whose value is `undefined`,
 * so such an assertion passes even when the keys are absent entirely. Key
 * *presence* is the clearing mechanism — `updateEnvironment` only writes a field
 * when `field in updates` (storage.ts) — so check the keys explicitly.
 */
function expectClearsPendingAgentLaunch(update: unknown): void {
  const keys = Object.keys(update as Record<string, unknown>);
  expect(keys).toContain("pendingAgentLaunch");
  expect(keys).toContain("initialAgentModel");
  expect(keys).toContain("initialReasoningEffort");
  expect(keys).toContain("initialPromptAttachments");
  const record = update as Record<string, unknown>;
  expect(record.pendingAgentLaunch).toBe(false);
  expect(record.initialAgentModel).toBeUndefined();
  expect(record.initialReasoningEffort).toBeUndefined();
  expect(record.initialPromptAttachments).toBeUndefined();
}

/** The `updateEnvironment` updates recorded for a given status, in order. */
function updatesWithStatus(
  updates: Record<string, unknown>[],
  status: string,
): Record<string, unknown>[] {
  return updates.filter((update) => update.status === status);
}

/**
 * A local worktree sitting one commit ahead of `origin/main`, with the round's
 * Git-excluded artifact directory created but empty. Each caller writes only the
 * validation evidence its own scenario needs.
 */
async function createReviewPackageWorktree(options: {
  packageId: string;
  extraCommittedFiles?: Record<string, Buffer>;
}): Promise<{
  worktreePath: string;
  artifactDirectory: string;
  baseRef: string;
  headRef: string;
  content: string;
}> {
  const worktreePath = await createTempDir("ork-electron-generate-package-");
  await execFileAsync("git", ["init", worktreePath]);
  await execFileAsync("git", ["-C", worktreePath, "config", "user.email", "test@example.invalid"]);
  await execFileAsync("git", ["-C", worktreePath, "config", "user.name", "Test"]);
  await fs.writeFile(path.join(worktreePath, "review.txt"), "before\n");
  await execFileAsync("git", ["-C", worktreePath, "add", "review.txt"]);
  await execFileAsync("git", ["-C", worktreePath, "commit", "-m", "base"]);
  await execFileAsync("git", ["-C", worktreePath, "branch", "-M", "main"]);
  const { stdout: baseOutput } = await execFileAsync(
    "git",
    ["-C", worktreePath, "rev-parse", "HEAD"],
  );
  const baseRef = baseOutput.trim();
  await execFileAsync(
    "git",
    ["-C", worktreePath, "update-ref", "refs/remotes/origin/main", baseRef],
  );
  await execFileAsync("git", ["-C", worktreePath, "checkout", "-b", "feature/local"]);
  const content = "after\n";
  await fs.writeFile(path.join(worktreePath, "review.txt"), content);
  const extraNames = Object.keys(options.extraCommittedFiles ?? {});
  for (const name of extraNames) {
    await fs.writeFile(path.join(worktreePath, name), options.extraCommittedFiles![name]);
  }
  await execFileAsync(
    "git",
    ["-C", worktreePath, "add", "review.txt", ...extraNames],
  );
  await execFileAsync("git", ["-C", worktreePath, "commit", "-m", "change"]);
  const { stdout: headOutput } = await execFileAsync(
    "git",
    ["-C", worktreePath, "rev-parse", "HEAD"],
  );
  const artifactDirectory = path.join(
    worktreePath,
    ".orkestrator",
    "review-artifacts",
    options.packageId,
  );
  await fs.mkdir(artifactDirectory, { recursive: true });
  return {
    worktreePath,
    artifactDirectory,
    baseRef,
    headRef: headOutput.trim(),
    content,
  };
}

async function withFixedDate<T>(iso: string, fn: () => Promise<T> | T): Promise<T> {
  const RealDate = Date;
  const fixedTime = new RealDate(iso).getTime();

  globalThis.Date = class FixedDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) {
        super(fixedTime);
      } else if (args.length === 1) {
        super(args[0]);
      } else {
        super(
          args[0],
          args[1],
          args[2] ?? 1,
          args[3] ?? 0,
          args[4] ?? 0,
          args[5] ?? 0,
          args[6] ?? 0,
        );
      }
    }

    static now() {
      return fixedTime;
    }
  } as DateConstructor;

  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

function createContext(
  environmentOrEnvironments: Environment | Environment[],
  options: {
    project?: { id: string; name: string; gitUrl: string; localPath: string | null; addedAt: string; order: number };
    repositoryConfig?: RepositoryConfig;
    globalConfig?: Record<string, unknown>;
    cacheAgentModelCatalog?: (
      agent: "claude" | "codex",
      models: unknown[],
    ) => Promise<unknown>;
  } = {},
): {
  context: CommandContext;
  updates: Array<Record<string, unknown>>;
  emitted: Array<{ event: string; payload: unknown }>;
} {
  const environments = Array.isArray(environmentOrEnvironments) ? environmentOrEnvironments : [environmentOrEnvironments];
  const projects = [{
    id: "project-1",
    name: "repo",
    gitUrl: "https://github.com/acme/repo.git",
    localPath: null,
    addedAt: new Date(0).toISOString(),
    order: 0,
  }];
  const repositoryConfig = options.repositoryConfig ?? {
    defaultBranch: "main",
    prBaseBranch: "main",
  };
  const config = {
    version: "1.0.0",
    global: options.globalConfig ?? {},
    repositories: {
      "project-1": repositoryConfig,
    },
  };
  const updates: Array<Record<string, unknown>> = [];
  const emitted: Array<{ event: string; payload: unknown }> = [];
  let desktopConnections = { activeConnectionId: "local", connections: [] as Array<Record<string, unknown>> };
  const context = {
    appRoot: "",
    resourceRoot: "",
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    emit: mock((event: string, payload: unknown) => {
      emitted.push({ event, payload });
    }),
    storage: {
      withGitHubCompletionCommentLock: mock(async (
        _pipelineId: string,
        operation: () => Promise<unknown>,
      ) => operation()),
      getProject: mock(async (projectId: string) => projects.find((project) => project.id === projectId) ?? null),
      getRepositoryConfig: mock(async (projectId: string) => config.repositories[projectId as "project-1"] ?? { defaultBranch: "main", prBaseBranch: "main" }),
      loadConfig: mock(async () => config),
      saveConfig: mock(async (nextConfig: typeof config) => {
        Object.assign(config, nextConfig);
      }),
      updateRepositoryConfig: mock(async (projectId: string, nextConfig: RepositoryConfig) => {
        config.repositories[projectId as "project-1"] = nextConfig;
        return config;
      }),
      getDesktopConnections: mock(async () => desktopConnections),
      saveDesktopConnections: mock(async (nextConnections: typeof desktopConnections) => {
        desktopConnections = nextConnections;
      }),
      cacheAgentModelCatalog: mock(
        options.cacheAgentModelCatalog
          ?? (async () => ({ schemaVersion: 1 as const })),
      ),
      getEnvironment: mock(async (environmentId: string) => environments.find((environment) => environment.id === environmentId) ?? null),
      getEnvironmentsByProject: mock(async (projectId: string) => environments.filter((environment) => environment.projectId === projectId)),
      loadEnvironments: mock(async () => environments),
      addEnvironment: mock(async (environment: Environment) => {
        environment.order =
          Math.max(-1, ...environments.filter((item) => item.projectId === environment.projectId).map((item) => item.order)) + 1;
        environments.push(environment);
        return environment;
      }),
      updateEnvironment: mock(async (environmentId: string, update: Record<string, unknown>) => {
        const environment = environments.find((candidate) => candidate.id === environmentId);
        if (!environment) throw new Error(`Environment not found: ${environmentId}`);
        updates.push(update);
        Object.assign(environment, update);
        return environment;
      }),
      recordEnvironmentActivity: mock(async (environmentId: string, occurredAt: string) => {
        const activityTime = Date.parse(occurredAt);
        if (!Number.isFinite(activityTime)) {
          throw new Error("occurredAt must be a valid ISO timestamp");
        }
        const environment = environments.find((candidate) => candidate.id === environmentId);
        if (!environment) throw new Error(`Environment not found: ${environmentId}`);
        const previousTime = environment.lastActivityAt
          ? Date.parse(environment.lastActivityAt)
          : Number.NEGATIVE_INFINITY;
        if (Number.isFinite(previousTime) && previousTime >= activityTime) return environment;
        const update = { lastActivityAt: new Date(activityTime).toISOString() };
        updates.push(update);
        Object.assign(environment, update);
        return environment;
      }),
      recordEnvironmentCompletion: mock(async (environmentId: string, occurredAt: string) => {
        const activityTime = Date.parse(occurredAt);
        if (!Number.isFinite(activityTime)) {
          throw new Error("occurredAt must be a valid ISO timestamp");
        }
        const environment = environments.find((candidate) => candidate.id === environmentId);
        if (!environment) throw new Error(`Environment not found: ${environmentId}`);
        const previousTime = environment.lastActivityAt
          ? Date.parse(environment.lastActivityAt)
          : Number.NEGATIVE_INFINITY;
        if (Number.isFinite(previousTime) && previousTime >= activityTime) return environment;
        const update = {
          lastActivityAt: new Date(activityTime).toISOString(),
          hasUnreadWork: true,
        };
        updates.push(update);
        Object.assign(environment, update);
        return environment;
      }),
      removeEnvironment: mock(async (environmentId: string) => {
        const index = environments.findIndex((candidate) => candidate.id === environmentId);
        if (index >= 0) environments.splice(index, 1);
      }),
      removeSessionsByEnvironment: mock(async () => undefined),
      deleteNativeAgentSessionsByEnvironment: mock(async () => undefined),
      deleteLoopedReviewWorkflowsByEnvironment: mock(async () => undefined),
      deleteBuildPipelinesByEnvironment: mock(async () => [] as string[]),
      deletePromptQueuesByEnvironment: mock(async () => [] as string[]),
      deleteComposeDraftsByEnvironment: mock(async () => undefined),
      deleteFileDraftsByEnvironment: mock(async () => undefined),
      deleteAgentHandoffsByEnvironment: mock(async () => [] as string[]),
      deletePaneLayout: mock(async () => undefined),
      getKanbanTasks: mock(async () => []),
      listBuildPipelines: mock(async () => []),
      updateKanbanTask: mock(async () => undefined),
      addKanbanComment: mock(async () => undefined),
      getProject: mock(async (projectId: string) => {
        if (options.project) return options.project.id === projectId ? options.project : null;
        return {
          id: "project-1",
          name: "Project",
          gitUrl: "https://github.com/acme/project.git",
          localPath: null,
          addedAt: new Date(0).toISOString(),
          order: 0,
        };
      }),
      getRepositoryConfig: mock(async () => repositoryConfig),
    },
  } as unknown as CommandContext;

  return { context, updates, emitted };
}

/**
 * A `fetchedAt` the catalog cache will accept as fresh.
 *
 * `isFreshClaudeModelCatalog` applies a **5-minute** TTL, so a hardcoded absolute
 * date is a time bomb: it reads as fresh only within five minutes of that instant
 * and then fails forever. Keep this relative to now.
 */
function freshFetchedAt(): string {
  return new Date().toISOString();
}

async function writeBridgeEntrypoint(
  appRoot: string,
  bridgeName: "claude-bridge" | "codex-bridge",
  source: string,
): Promise<void> {
  const bridgeDist = path.join(appRoot, "bridges", bridgeName, "dist");
  await fs.mkdir(bridgeDist, { recursive: true });
  await fs.writeFile(path.join(bridgeDist, "index.js"), source);
}

async function writeBridgeServer(
  appRoot: string,
  bridgeName: "claude-bridge" | "codex-bridge",
  environmentMarkerPath?: string,
  modelCatalog?: Record<string, unknown>,
  versionMarkerPath?: string,
  maxConcurrentThreadsMarkerPath?: string,
): Promise<void> {
  const bridgeDist = path.join(appRoot, "bridges", bridgeName, "dist");
  await fs.mkdir(bridgeDist, { recursive: true });
  await fs.writeFile(
    path.join(bridgeDist, "index.js"),
    `
      const http = require("node:http");
      const port = Number(process.env.PORT);
      ${environmentMarkerPath
        ? `require("node:fs").writeFileSync(${JSON.stringify(environmentMarkerPath)}, process.env.${bridgeName === "claude-bridge" ? "CLAUDE_CLI_PATH" : "CODEX_PATH"} ?? "");`
        : ""}
      ${versionMarkerPath
        ? `require("node:fs").writeFileSync(${JSON.stringify(versionMarkerPath)}, process.env.ORKESTRATOR_VERSION ?? "");`
        : ""}
      ${maxConcurrentThreadsMarkerPath
        ? `require("node:fs").writeFileSync(${JSON.stringify(maxConcurrentThreadsMarkerPath)}, process.env.CODEX_MAX_CONCURRENT_THREADS_PER_SESSION ?? "");`
        : ""}
      http.createServer((req, res) => {
        if (req.url === "/global/health") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        ${modelCatalog
          ? `if (req.url === "/config/models") {
          res.writeHead(200, {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
          });
          res.end(${JSON.stringify(JSON.stringify(modelCatalog))});
          return;
        }`
          : ""}
        res.writeHead(404);
        res.end();
      }).listen(port, "127.0.0.1");
    `,
  );
}

/**
 * Stands in for an in-container bridge on a fixed port. `isHealthy` is consulted
 * per request so a test can flip health between the handler's own check and the
 * one inside `startContainerServer`.
 */
async function startControllableHealthServer(
  port: number,
  isHealthy: () => boolean,
): Promise<{ close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    response.writeHead(request.url === "/global/health" && isHealthy() ? 200 : 503);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    close: () => new Promise<void>((resolve, reject) => {
      // Dropping keep-alive sockets can already stop the listener, so a
      // "not running" close is success rather than a leaked port.
      server.closeAllConnections();
      server.close((error) => (
        !error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING"
          ? resolve()
          : reject(error)
      ));
    }),
  };
}

async function startAuthenticatedContainerServer(
  port: number,
  options: {
    isHealthy: () => boolean;
    isAuthorized: (request: http.IncomingMessage) => boolean;
  },
): Promise<{ close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    if (!options.isHealthy()) {
      // A stopped container process refuses the connection. This lets the
      // production reachability check distinguish it from a live 401.
      request.socket.destroy();
      return;
    }
    if (request.url === "/global/health") {
      const suppliedCredential =
        request.headers.authorization
        || request.headers["x-orkestrator-claude-token"];
      response.writeHead(
        suppliedCredential && !options.isAuthorized(request) ? 401 : 200,
      );
      response.end();
      return;
    }
    if (request.url === "/global/auth-check") {
      response.writeHead(options.isAuthorized(request) ? 200 : 401);
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (
        !error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING"
          ? resolve()
          : reject(error)
      ));
    }),
  };
}

function readTestCredential(file: string): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

async function requestOk(
  port: number,
  requestPath: string,
  headers?: Record<string, string>,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const request = http.get({
      host: "127.0.0.1",
      port,
      path: requestPath,
      timeout: 2_000,
      headers,
    }, (response) => {
      response.resume();
      resolve((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300);
    });
    request.once("timeout", () => {
      request.destroy(new Error("request timed out"));
    });
    request.once("error", reject);
  });
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function createGitWorktreeWithOrigin(): Promise<{ worktree: string; remote: string }> {
  const root = await createTempDir("ork-electron-git-");
  const remote = path.join(root, "origin.git");
  const worktree = path.join(root, "worktree");

  await runGit(root, ["init", "--bare", remote]);
  await fs.mkdir(worktree, { recursive: true });
  await runGit(worktree, ["init"]);
  await runGit(worktree, ["checkout", "-b", "main"]);
  await runGit(worktree, ["config", "user.name", "Test User"]);
  await runGit(worktree, ["config", "user.email", "test@example.com"]);
  await fs.writeFile(path.join(worktree, "tracked.txt"), "base\n");
  await runGit(worktree, ["add", "tracked.txt"]);
  await runGit(worktree, ["commit", "-m", "base"]);
  await runGit(worktree, ["remote", "add", "origin", remote]);
  await runGit(worktree, ["push", "-u", "origin", "main"]);

  return { worktree, remote };
}

// Points the Codex lookup at empty managed/resource roots so it falls back to the
// fake `codex` on PATH instead of a cached or legacy packaged binary.
async function isolateCodexBinaryLookup(context: CommandContext): Promise<void> {
  const root = await createTempDir("ork-codex-root-");
  context.appRoot = root;
  context.resourceRoot = root;
  context.toolchainBinDir = root;
}

async function createGitRepoOnBranch(branch: string): Promise<string> {
  const repo = await createTempDir("ork-electron-rename-repo-");
  await runGit(repo, ["init"]);
  await runGit(repo, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(repo, "tracked.txt"), "base\n");
  await runGit(repo, ["add", "tracked.txt"]);
  await runGit(repo, ["commit", "-m", "base"]);
  return repo;
}

async function currentGitBranch(repo: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, "branch", "--show-current"]);
  return stdout.trim();
}

async function currentGitCommit(repo: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"]);
  return stdout.trim();
}

function expectedManagedWorktreePath(projectName: string, branch: string): string {
  return path.join(os.homedir(), APP_SLUG, "workspaces", `${projectName}-${branch}`);
}

async function expectLocalWorktreeRolledBack(projectPath: string, worktreePath: string, branch: string): Promise<void> {
  expect(existsSync(worktreePath)).toBe(false);

  const { stdout: branches } = await execFileAsync("git", ["-C", projectPath, "branch", "--list", branch]);
  expect(branches.trim()).toBe("");

  const { stdout: worktrees } = await execFileAsync("git", ["-C", projectPath, "worktree", "list", "--porcelain"]);
  expect(worktrees).not.toContain(worktreePath);
}

// Stub `codex` that writes the requested slug JSON to the --output-last-message path.
function codexSlugScript(slug: string): string {
  return `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CODEX_LOG"
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then
    out="$arg"
  fi
  prev="$arg"
done
[ -n "$out" ] || exit 2
printf '%s\\n' '{"slug":"${slug}"}' > "$out"
`;
}

async function withFakeDocker(scriptBody: string, run: (logs: { all: string; rm: string; exec: string }) => Promise<void>): Promise<void> {
  const root = await createTempDir("ork-electron-fake-docker-");
  const binDir = path.join(root, "bin");
  const all = path.join(root, "docker.log");
  const rm = path.join(root, "docker-rm.log");
  const exec = path.join(root, "docker-exec.log");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "docker"), scriptBody);
  await fs.chmod(path.join(binDir, "docker"), 0o755);

  const originalPath = process.env.PATH;
  const originalDockerLog = process.env.FAKE_DOCKER_LOG;
  const originalDockerRmLog = process.env.FAKE_DOCKER_RM_LOG;
  const originalDockerExecLog = process.env.FAKE_DOCKER_EXEC_LOG;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.FAKE_DOCKER_LOG = all;
  process.env.FAKE_DOCKER_RM_LOG = rm;
  process.env.FAKE_DOCKER_EXEC_LOG = exec;

  try {
    await run({ all, rm, exec });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalDockerLog === undefined) delete process.env.FAKE_DOCKER_LOG;
    else process.env.FAKE_DOCKER_LOG = originalDockerLog;
    if (originalDockerRmLog === undefined) delete process.env.FAKE_DOCKER_RM_LOG;
    else process.env.FAKE_DOCKER_RM_LOG = originalDockerRmLog;
    if (originalDockerExecLog === undefined) delete process.env.FAKE_DOCKER_EXEC_LOG;
    else process.env.FAKE_DOCKER_EXEC_LOG = originalDockerExecLog;
  }
}

/** Puts a `git` on PATH that prints `output` for `subcommand` and still exits 0. */
async function withFakeGitSubcommandOutput(
  subcommand: string,
  output: string,
  run: () => Promise<void>,
): Promise<void> {
  const root = await createTempDir("ork-electron-fake-git-output-");
  const binDir = path.join(root, "bin");
  const { stdout } = await execFileAsync("which", ["git"]);
  const realGit = stdout.trim().replaceAll("'", "'\\''");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "git"), `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = '${subcommand.replaceAll("'", "'\\''")}' ]; then
    printf '%s\\n' '${output.replaceAll("'", "'\\''")}'
    exit 0
  fi
done
exec '${realGit}' "$@"
`);
  await fs.chmod(path.join(binDir, "git"), 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  try {
    await run();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
}

/**
 * Provides a `base64` that understands GNU's `-w0`, so the container script can be
 * run on a developer machine. macOS base64 rejects the flag but never wraps, and
 * GNU base64 wraps at 76 columns without it, so each needs opposite handling.
 */
async function withGnuBase64Shim(run: (env: NodeJS.ProcessEnv) => Promise<void>): Promise<void> {
  const root = await createTempDir("ork-electron-base64-shim-");
  const binDir = path.join(root, "bin");
  const { stdout } = await execFileAsync("which", ["base64"]);
  const realBase64 = stdout.trim().replaceAll("'", "'\\''");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "base64"), `#!/bin/sh
if printf '' | '${realBase64}' -w0 >/dev/null 2>&1; then
  exec '${realBase64}' "$@"
fi
if [ "$1" = "-w0" ]; then shift; fi
exec '${realBase64}' "$@"
`);
  await fs.chmod(path.join(binDir, "base64"), 0o755);

  await run({ ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` });
}

/**
 * Records every `git` invocation containing `subcommand` and forwards it to the
 * real git, so a test can assert that a subcommand was - or was not - reached.
 */
async function withGitSubcommandLog(
  subcommand: string,
  run: (logPath: string) => Promise<void>,
): Promise<void> {
  const root = await createTempDir("ork-electron-git-log-");
  const binDir = path.join(root, "bin");
  const logPath = path.join(root, "git-invocations.log");
  const { stdout } = await execFileAsync("which", ["git"]);
  const realGit = stdout.trim().replaceAll("'", "'\\''");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "git"), `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = '${subcommand.replaceAll("'", "'\\''")}' ]; then
    printf '%s\\n' "$*" >> '${logPath.replaceAll("'", "'\\''")}'
    break
  fi
done
exec '${realGit}' "$@"
`);
  await fs.chmod(path.join(binDir, "git"), 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  try {
    await run(logPath);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
}

async function withFailingGitSubcommand(subcommand: string, run: () => Promise<void>): Promise<void> {
  const root = await createTempDir("ork-electron-fake-git-");
  const binDir = path.join(root, "bin");
  const { stdout } = await execFileAsync("which", ["git"]);
  const realGit = stdout.trim().replaceAll("'", "'\\''");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "git"), `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = '${subcommand.replaceAll("'", "'\\''")}' ]; then
    echo "forced ${subcommand} failure" >&2
    exit 42
  fi
done
exec '${realGit}' "$@"
`);
  await fs.chmod(path.join(binDir, "git"), 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  try {
    await run();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
}

async function withFakeGh(scriptBody: string, run: (logPath: string) => Promise<void>): Promise<void> {
  const root = await createTempDir("ork-electron-fake-gh-");
  const binDir = path.join(root, "bin");
  const log = path.join(root, "gh.log");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "gh"), scriptBody);
  await fs.chmod(path.join(binDir, "gh"), 0o755);

  const originalPath = process.env.PATH;
  const originalGhLog = process.env.FAKE_GH_LOG;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.FAKE_GH_LOG = log;

  try {
    await run(log);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalGhLog === undefined) delete process.env.FAKE_GH_LOG;
    else process.env.FAKE_GH_LOG = originalGhLog;
  }
}

async function withFakeCodex(scriptBody: string, run: (logPath: string) => Promise<void>): Promise<void> {
  const root = await createTempDir("ork-electron-fake-codex-");
  const binDir = path.join(root, "bin");
  const log = path.join(root, "codex.log");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "codex"), scriptBody);
  await fs.chmod(path.join(binDir, "codex"), 0o755);

  const originalPath = process.env.PATH;
  const originalCodexLog = process.env.FAKE_CODEX_LOG;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.FAKE_CODEX_LOG = log;

  try {
    await run(log);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalCodexLog === undefined) delete process.env.FAKE_CODEX_LOG;
    else process.env.FAKE_CODEX_LOG = originalCodexLog;
  }
}

function expectedLocalShellPath(): string {
  const configuredShell = process.env.SHELL?.trim();
  if (configuredShell && path.isAbsolute(configuredShell) && existsSync(configuredShell)) {
    return configuredShell;
  }
  return ["/bin/zsh", "/bin/bash", "/bin/sh"].find((candidate) => existsSync(candidate)) ?? configuredShell ?? "zsh";
}

const ASYNC_TEST_WAIT_TIMEOUT_MS = 3_000;
/**
 * Per-test budget for the tests that use the wait helpers below.
 *
 * Bun's default is 5s, which two of these tests can exhaust on their own: they
 * await a helper twice, so the worst case is 2 x ASYNC_TEST_WAIT_TIMEOUT_MS
 * before any fixture setup is counted. Without an explicit budget a slow run
 * dies on Bun's generic "timed out after 5000ms" instead of the helper's message
 * naming the condition that never became true.
 */
const ASYNC_TEST_BUDGET_MS = 20_000;

async function waitForPtyProcessCount(
  count: number,
  timeoutMs = ASYNC_TEST_WAIT_TIMEOUT_MS,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (ptyProcesses.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${count} PTY process(es), saw ${ptyProcesses.length}`);
}

async function waitForCondition(
  condition: () => boolean,
  description: string,
  timeoutMs = ASYNC_TEST_WAIT_TIMEOUT_MS,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function createFakeChild(pid: number): ChildProcessWithoutNullStreams {
  return {
    pid,
    exitCode: null,
    signalCode: null,
    kill: mock(() => true),
  } as unknown as ChildProcessWithoutNullStreams;
}

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// Fake `docker` that reports the container as running and succeeds on exec,
// returning a deterministic HEAD commit for `git rev-parse`.
const RUNNING_CONTAINER_DOCKER_SCRIPT = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
  case "$*" in
    *ORKESTRATOR_SETUP_CAPABILITIES*)
      printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
      exit 0
      ;;
    *--prepare-only*)
      printf '\\036ORKESTRATOR_PREPARE_OK\\037'
      exit 0
      ;;
    *rev-parse*)
      printf '1111111111111111111111111111111111111111\\n'
      ;;
  esac
  exit 0
fi
exit 0
`;

afterEach(async () => {
  try {
    await shutdownLocalServers();
  } finally {
    shutdownDiffStatsTracking();
    // Commands like set_environment_pr arm PR monitoring as a side effect;
    // dropping the entries here keeps a scheduled poll from spawning `gh`
    // against a fixture worktree later in the run.
    shutdownPrMonitorTracking();
    commandTesting.resetLocalServerLifecycle();
    commandTesting.resetDockerContainerStateCache();
    commandTesting.resetTerminalOutputBuffers();
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    showOpenDialog.mockClear();
    ptySpawn.mockClear();
    ptyProcesses.splice(0);
  }
});

afterAll(async () => {
  const commands = createCommandRegistry();
  await commands.get("stop_local_codex_server_cmd")?.({ environmentId: "env-local" }, createContext(createEnvironment()).context);
});

// These helpers are the failure reporting path for most of the async tests in
// this file, so their timeout messages are the first thing a developer reads
// when a suite goes red. Pinning them keeps that diagnostic from silently
// regressing to Bun's generic per-test timeout.
describe("async test wait helpers", () => {
  test("reports the condition that never became true", async () => {
    await expect(
      waitForCondition(() => false, "a condition that never holds", 20),
    ).rejects.toThrow("Timed out waiting for a condition that never holds");
  });

  test("reports both the expected and observed PTY process counts", async () => {
    ptyProcesses.splice(0);
    await expect(waitForPtyProcessCount(2, 20)).rejects.toThrow(
      "Timed out waiting for 2 PTY process(es), saw 0",
    );
  });

  test("returns as soon as the condition holds without exhausting the timeout", async () => {
    let ready = false;
    setTimeout(() => { ready = true; }, 10);
    const start = Date.now();
    await waitForCondition(() => ready, "a condition that becomes true", 5_000);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});

describe("Electron backend command registry", () => {
  test("loads, validates, and saves desktop connection records", async () => {
    const commands = createCommandRegistry();
    const { context } = createContext([]);
    await expect(commands.get("get_desktop_connections")?.({}, context)).resolves.toEqual({
      activeConnectionId: "local",
      connections: [],
    });
    const remote = {
      activeConnectionId: "remote-1",
      connections: [{
        id: "remote-1",
        name: "desk.example",
        address: "https://desk.example",
        encryptedToken: "encrypted",
        lastConnectedAt: "2026-07-14T00:00:00.000Z",
      }],
    };
    await commands.get("save_desktop_connections")?.({ desktopConnections: remote }, context);
    await expect(commands.get("get_desktop_connections")?.({}, context)).resolves.toEqual(remote);
    expect(() => commands.get("save_desktop_connections")?.({ desktopConnections: { activeConnectionId: "local" } }, context)).toThrow("connections");
  });

  test("registers every command exposed by the typed frontend wrapper", async () => {
    const source = await fs.readFile(path.join(process.cwd(), "apps", "web", "src", "lib", "backend.ts"), "utf8");
    const exposedCommands = Array.from(source.matchAll(/invoke(?:<[^>]+>)?\("([^"]+)"/g), (match) => match[1]);
    const commands = createCommandRegistry();

    for (const command of exposedCommands) {
      expect(commands.has(command)).toBe(true);
    }
  });

  test("validates and delegates resource revision manifest requests", async () => {
    const generation = "a".repeat(32);
    const projectRevision = "b".repeat(32);
    const response = {
      generation,
      reset: false,
      revisions: { project: projectRevision },
    };
    const getResourceRevisionManifest = mock(async () => response);
    const context = {
      storage: { getResourceRevisionManifest },
    } as unknown as CommandContext;
    const command = createCommandRegistry().get("get_resource_revision_manifest")!;

    await expect(command({
      knownGeneration: generation,
      knownRevisions: { project: projectRevision },
    }, context)).resolves.toEqual(response);
    expect(getResourceRevisionManifest).toHaveBeenCalledWith(
      generation,
      { project: projectRevision },
    );

    await expect(command({}, context)).resolves.toEqual(response);
    expect(getResourceRevisionManifest).toHaveBeenLastCalledWith(undefined, {});

    for (const knownRevisions of [null, [], "revisions"]) {
      expect(() => command({ knownRevisions }, context)).toThrow("knownRevisions");
    }
    expect(() => command({
      knownRevisions: { unknown: projectRevision },
    }, context)).toThrow("Unknown manifest resource: unknown");
    expect(() => command({
      knownRevisions: { project: "invalid" },
    }, context)).toThrow("Invalid manifest revision for project");
    expect(() => command({
      knownGeneration: "invalid",
    }, context)).toThrow("knownGeneration must be an opaque resource generation");
    expect(getResourceRevisionManifest).toHaveBeenCalledTimes(2);
  });

  test("requires paired, well-formed conditional snapshot cursors", async () => {
    const generation = "a".repeat(32);
    const revision = "b".repeat(32);
    const storage = {
      loadProjects: mock(async () => []),
      readConditionalResourceSnapshot: mock(async () => ({
        status: "unchanged" as const,
        generation,
        revision,
      })),
    };
    const context = { storage } as unknown as CommandContext;
    const command = createCommandRegistry().get("get_projects")!;

    await expect(command({ knownManifestGeneration: generation }, context))
      .rejects.toThrow(
        "knownManifestGeneration and knownResourceRevision must be provided together",
      );
    await expect(command({ knownResourceRevision: revision }, context))
      .rejects.toThrow(
        "knownManifestGeneration and knownResourceRevision must be provided together",
      );
    for (const knownManifestGeneration of [null, 42, "A".repeat(32), "a".repeat(31)]) {
      await expect(command({
        knownManifestGeneration,
        knownResourceRevision: revision,
      }, context)).rejects.toThrow(
        "knownManifestGeneration must be an opaque resource generation",
      );
    }
    for (const knownResourceRevision of [null, 42, "B".repeat(32), "b".repeat(33)]) {
      await expect(command({
        knownManifestGeneration: generation,
        knownResourceRevision,
      }, context)).rejects.toThrow(
        "knownResourceRevision must be an opaque resource revision",
      );
    }
    expect(storage.readConditionalResourceSnapshot).not.toHaveBeenCalled();
    expect(storage.loadProjects).not.toHaveBeenCalled();
  });

  test("preserves legacy snapshots and returns changed and unchanged envelopes", async () => {
    const generation = "a".repeat(32);
    const revision = "b".repeat(32);
    const projects = [{ id: "project-1" }];
    const loadProjects = mock(async () => projects);
    const readConditionalResourceSnapshot = mock(async (
      _resource: string,
      requestedGeneration: string,
      _requestedRevision: string,
      load: () => Promise<unknown> | unknown,
    ) => ({
      status: "changed" as const,
      generation: requestedGeneration,
      revision,
      snapshot: await load(),
    }));
    const storage = { loadProjects, readConditionalResourceSnapshot };
    const context = { storage } as unknown as CommandContext;
    const command = createCommandRegistry().get("get_projects")!;

    await expect(command({}, context)).resolves.toEqual(projects);
    expect(readConditionalResourceSnapshot).not.toHaveBeenCalled();

    await expect(command({
      knownManifestGeneration: generation,
      knownResourceRevision: revision,
    }, context)).resolves.toEqual({
      status: "changed",
      generation,
      revision,
      snapshot: projects,
    });
    expect(readConditionalResourceSnapshot).toHaveBeenCalledWith(
      "project",
      generation,
      revision,
      expect.any(Function),
    );

    readConditionalResourceSnapshot.mockImplementation(async () => ({
      status: "unchanged" as const,
      generation,
      revision,
    }));
    loadProjects.mockClear();
    await expect(command({
      knownManifestGeneration: generation,
      knownResourceRevision: revision,
    }, context)).resolves.toEqual({
      status: "unchanged",
      generation,
      revision,
    });
    expect(loadProjects).not.toHaveBeenCalled();
  });

  test("routes all manifest-backed snapshot commands through their resource cursor", async () => {
    const generation = "a".repeat(32);
    const revision = "b".repeat(32);
    const rawConfig = {
      version: "1.0.0",
      global: { githubToken: "configured-token" },
      repositories: {},
    };
    const storage = {
      loadProjects: mock(async () => [{ id: "project-1" }]),
      loadConfig: mock(async () => rawConfig),
      getEnvironmentsByProject: mock(async () => []),
      getSessionsByEnvironment: mock(async () => []),
      getPaneLayout: mock(async () => null),
      listLoopedReviewWorkflows: mock(async () => []),
      listBuildPipelines: mock(async () => []),
      listPromptQueues: mock(async () => []),
      getKanbanTasks: mock(async () => []),
      getProjectNotes: mock(async () => ({ projectId: "project-1", content: "notes" })),
      getFeaturePlans: mock(async () => []),
      readConditionalResourceSnapshot: mock(async (
        _resource: string,
        requestedGeneration: string,
        _requestedRevision: string,
        load: () => Promise<unknown> | unknown,
      ) => ({
        status: "changed" as const,
        generation: requestedGeneration,
        revision,
        snapshot: await load(),
      })),
    };
    const context = { storage } as unknown as CommandContext;
    const commands = createCommandRegistry();
    const cases = [
      { command: "get_projects", resource: "project", args: {}, snapshot: [{ id: "project-1" }] },
      {
        command: "get_config",
        resource: "config",
        args: {},
        snapshot: {
          version: "1.0.0",
          global: { githubTokenConfigured: true },
          repositories: {},
        },
      },
      { command: "get_environment_snapshots", resource: "environment", args: { projectId: "project-1" }, snapshot: [] },
      { command: "get_sessions_by_environment", resource: "session", args: { environmentId: "env-1" }, snapshot: [] },
      { command: "get_pane_layout", resource: "pane-layout", args: { environmentId: "env-1" }, snapshot: null },
      { command: "list_looped_review_workflows", resource: "looped-review", args: { environmentId: "env-1" }, snapshot: [] },
      { command: "list_build_pipelines", resource: "build-pipeline", args: { projectId: "project-1" }, snapshot: [] },
      { command: "list_prompt_queues", resource: "prompt-queue", args: { environmentId: "env-1" }, snapshot: [] },
      { command: "get_kanban_tasks", resource: "kanban", args: { projectId: "project-1" }, snapshot: [] },
      {
        command: "get_project_notes",
        resource: "project-notes",
        args: { projectId: "project-1" },
        snapshot: { projectId: "project-1", content: "notes" },
      },
      { command: "get_feature_plans", resource: "feature-plan", args: { projectId: "project-1" }, snapshot: [] },
    ] as const;

    for (const entry of cases) {
      storage.readConditionalResourceSnapshot.mockClear();
      await expect(commands.get(entry.command)?.({
        ...entry.args,
        knownManifestGeneration: generation,
        knownResourceRevision: revision,
      }, context)).resolves.toEqual({
        status: "changed",
        generation,
        revision,
        snapshot: entry.snapshot,
      });
      expect(storage.readConditionalResourceSnapshot).toHaveBeenCalledWith(
        entry.resource,
        generation,
        revision,
        expect.any(Function),
      );

      storage.readConditionalResourceSnapshot.mockImplementationOnce(async () => ({
        status: "unchanged" as const,
        generation,
        revision,
      }));
      await expect(commands.get(entry.command)?.({
        ...entry.args,
        knownManifestGeneration: generation,
        knownResourceRevision: revision,
      }, context)).resolves.toEqual({
        status: "unchanged",
        generation,
        revision,
      });
    }
  });

  test("leaves directory picking to the connected client", async () => {
    const commands = createCommandRegistry();
    await expect(commands.get("browse_for_directory")?.({}, createContext(createEnvironment()).context)).resolves.toBeNull();
    expect(showOpenDialog).not.toHaveBeenCalled();
  });

  test("creates unnamed environments with a default timestamp while storing the initial prompt", async () => {
    const { context } = createContext([]);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CODEX_LOG"
exit 42
`, async (logPath) => {
      const result = await withFixedDate("2026-04-15T12:34:56.789Z", async () =>
        commands.get("create_environment")?.(
          {
            projectId: "project-1",
            initialPrompt: "Please review the OAuth callback flow",
            environmentType: "local",
          },
          context,
        ) as Promise<Environment>,
      );

      expect(result.name).toBe("20260415-123456");
      expect(result.branch).toBe("20260415-123456");
      expect(result.initialPrompt).toBe("Please review the OAuth callback flow");
      expect(result.createdAt).toBe("2026-04-15T12:34:56.789Z");
      expect(result.lastActivityAt).toBe(result.createdAt);
      await expect(fs.readFile(logPath, "utf8")).rejects.toThrow();
    });
  });

  test("creates unnamed environments from a naming prompt without running codex during create", async () => {
    const { context } = createContext([]);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CODEX_LOG"
exit 42
`, async (logPath) => {
      const result = await withFixedDate("2026-04-15T12:34:56.789Z", async () =>
        commands.get("create_environment")?.(
          {
            projectId: "project-1",
            namingPrompt: "Build task\n\nShip the feature\n\nAll checks green",
            environmentType: "containerized",
          },
          context,
        ) as Promise<Environment>,
      );

      expect(result.name).toBe("20260415-123456");
      expect(result.branch).toBe("20260415-123456");
      expect(result.initialPrompt).toBeUndefined();
      expect(result.pendingRenamePrompt).toBeUndefined();
      expect(
        (await context.storage.getEnvironment(result.id))?.pendingRenamePrompt,
      ).toBe("Build task\n\nShip the feature\n\nAll checks green");
      await expect(fs.readFile(logPath, "utf8")).rejects.toThrow();
    });
  });

  test("does not persist a naming prompt when an explicit environment name is provided", async () => {
    const { context } = createContext([]);
    const commands = createCommandRegistry();

    const result = await commands.get("create_environment")?.(
      {
        projectId: "project-1",
        name: "Manual Name",
        namingPrompt: "This should not replace the manual name",
        environmentType: "local",
      },
      context,
    ) as Environment;

    expect(result.name).toBe("manual-name");
    expect(result.pendingRenamePrompt).toBeUndefined();
  });

  test("persists the originating build pipeline on a created environment", async () => {
    const { context } = createContext([]);
    const commands = createCommandRegistry();

    const result = await commands.get("create_environment")?.(
      {
        projectId: "project-1",
        name: "GitHub issue build",
        environmentType: "local",
        buildPipelineId: "pipeline-github-42",
      },
      context,
    ) as Environment;

    expect(result.buildPipelineId).toBe("pipeline-github-42");
    expect(
      (await context.storage.getEnvironment(result.id))?.buildPipelineId,
    ).toBe("pipeline-github-42");
  });

  test("clears a pending prompt when the user manually renames the environment", async () => {
    const environment = createEnvironment({
      pendingRenamePrompt: "Generate a name after startup",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await commands.get("rename_environment")?.(
      { environmentId: environment.id, name: "Manual Choice" },
      context,
    );

    expect(environment.name).toBe("manual-choice");
    expect(environment.branch).toBe("manual-choice");
    expect(environment.pendingRenamePrompt).toBeUndefined();
  });

  test("completes a persisted prompt rename in the backend after startup", async () => {
    const worktreePath = await createGitRepoOnBranch("timestamp-name");
    const environment = createEnvironment({
      id: "env-pending-rename",
      name: "timestamp-name",
      branch: "timestamp-name",
      environmentType: "local",
      worktreePath,
      status: "stopped",
      setupScriptsComplete: true,
      pendingRenamePrompt: "Please review the OAuth callback flow",
    });
    const { context, emitted } = createContext(environment);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(codexSlugScript("Review OAuth Flow"), async () => {
      await expect(commands.get("start_environment")?.(
        { environmentId: environment.id },
        context,
      )).resolves.toEqual(expect.objectContaining({
        setupStarted: false,
        environment: expect.objectContaining({
          id: environment.id,
          status: "running",
        }),
      }));

      // The caller does not issue a separate rename command. The backend-owned
      // task survives a renderer reload and emits the normal rehydration event.
      await waitForCondition(
        () => emitted.some(({ event }) => event === "environment-renamed"),
        "pending environment rename",
      );

      expect(environment.name).toBe("review-oauth-flow");
      expect(environment.branch).toBe("review-oauth-flow");
      expect(environment.pendingRenamePrompt).toBeUndefined();
      expect(await currentGitBranch(worktreePath)).toBe("review-oauth-flow");
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("starting a stopped environment resumes backend PR polling", async () => {
    const worktreePath = await createGitRepoOnBranch("feature-pr-monitor");
    const environment = createEnvironment({
      id: "env-pr-monitor-resume",
      branch: "feature-pr-monitor",
      environmentType: "local",
      worktreePath,
      status: "running",
      setupScriptsComplete: true,
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "open",
      hasMergeConflicts: false,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    // Rehydrate the backend-owned entry, then stop the environment to exercise
    // the same pause path used by the desktop lifecycle.
    await commands.get("get_pr_monitor_state")?.({}, context);
    await commands.get("stop_environment")?.({ environmentId: environment.id }, context);

    await withFakeGh(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '[{"url":"https://github.com/acme/repo/pull/42","state":"OPEN","mergeable":"MERGEABLE","updatedAt":"2026-01-03T00:00:00Z"}]'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' '{"url":"https://github.com/acme/repo/pull/42","state":"OPEN","mergeable":"MERGEABLE"}'
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`, async (logPath) => {
      await commands.get("start_environment")?.({ environmentId: environment.id }, context);
      await commands.get("pr_monitor_refresh")?.({ environmentId: environment.id }, context);
      await waitForCondition(() => existsSync(logPath), "resumed PR monitor check");

      expect(await fs.readFile(logPath, "utf8")).toContain(
        "pr view https://github.com/acme/repo/pull/42 --json url,state,mergeable",
      );
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("retains a failed pending rename so a later backend start can retry it", async () => {
    const worktreePath = await createGitRepoOnBranch("timestamp-name");
    const environment = createEnvironment({
      id: "env-pending-rename-retry",
      name: "timestamp-name",
      branch: "timestamp-name",
      environmentType: "local",
      worktreePath,
      status: "stopped",
      setupScriptsComplete: true,
      pendingRenamePrompt: "Please review the OAuth callback flow",
    });
    const { context, emitted } = createContext(environment);
    await isolateCodexBinaryLookup(context);
    const originalConsoleWarn = console.warn;
    const consoleWarnMock = mock(() => undefined);
    console.warn = consoleWarnMock as typeof console.warn;

    try {
      await withFakeCodex(`#!/bin/sh
printf 'codex auth required\\n' >&2
exit 1
`, async () => {
        const firstRegistry = createCommandRegistry();
        await firstRegistry.get("start_environment")?.({ environmentId: environment.id }, context);
        await waitForCondition(
          () => consoleWarnMock.mock.calls.some(([message]) =>
            message === "[ElectronBackend] Failed to rename environment from pending prompt:"
          ),
          "failed pending rename to settle",
        );
      });

      expect(environment.pendingRenamePrompt).toBe("Please review the OAuth callback flow");
      expect(emitted.some(({ event }) => event === "environment-renamed")).toBe(false);

      await withFakeCodex(codexSlugScript("Review OAuth Flow"), async () => {
        // A fresh registry represents the backend process rebuilding its in-memory
        // task state while retaining the persisted environment snapshot.
        const restartedRegistry = createCommandRegistry();
        await restartedRegistry.get("start_environment")?.({ environmentId: environment.id }, context);
        await waitForCondition(
          () => emitted.some(({ event }) => event === "environment-renamed"),
          "retried pending environment rename",
        );
      });

      expect(environment.name).toBe("review-oauth-flow");
      expect(environment.pendingRenamePrompt).toBeUndefined();
    } finally {
      console.warn = originalConsoleWarn;
    }
  }, ASYNC_TEST_BUDGET_MS);

  test("resumes a persisted rename while rehydrating an already-running environment", async () => {
    const worktreePath = await createGitRepoOnBranch("timestamp-name");
    const environment = createEnvironment({
      id: "env-pending-rename-rehydrate",
      name: "timestamp-name",
      branch: "timestamp-name",
      environmentType: "local",
      worktreePath,
      status: "running",
      setupScriptsComplete: true,
      pendingRenamePrompt: "Reconcile the background session state",
    });
    const { context, emitted } = createContext(environment);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(codexSlugScript("Reconcile Session State"), async () => {
      await expect(commands.get("get_environments")?.(
        { projectId: environment.projectId },
        context,
      )).resolves.toEqual([expect.objectContaining({ id: environment.id, status: "running" })]);

      await waitForCondition(
        () => emitted.some(({ event }) => event === "environment-renamed"),
        "rehydrated pending environment rename",
      );
    });

    expect(environment.name).toBe("reconcile-session-state");
    expect(environment.pendingRenamePrompt).toBeUndefined();
    expect(await currentGitBranch(worktreePath)).toBe("reconcile-session-state");
  }, ASYNC_TEST_BUDGET_MS);

  test("does not run codex exec for initial-prompt-only environment naming", async () => {
    const { context } = createContext([]);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CODEX_LOG"
printf 'codex auth required\\n' >&2
exit 1
`, async (logPath) => {
      const result = await withFixedDate("2026-04-15T12:34:56.789Z", async () =>
        commands.get("create_environment")?.(
          {
            projectId: "project-1",
            initialPrompt: "Please review the OAuth callback flow",
            environmentType: "local",
          },
          context,
        ) as Promise<Environment>,
      );

      expect(result.name).toBe("20260415-123456");
      expect(result.branch).toBe("20260415-123456");
      expect(result.initialPrompt).toBe("Please review the OAuth callback flow");
      await expect(fs.readFile(logPath, "utf8")).rejects.toThrow();
    });
  });

  test("falls back to the default timestamp name when an initial prompt cannot form a slug", async () => {
    const { context } = createContext([]);
    const commands = createCommandRegistry();

    const result = await withFixedDate("2026-04-15T12:34:56.789Z", async () =>
      commands.get("create_environment")?.(
        {
          projectId: "project-1",
          initialPrompt: "🔥🔥🔥",
          environmentType: "local",
        },
        context,
      ) as Promise<Environment>,
    );

    expect(result.name).toBe("20260415-123456");
    expect(result.branch).toBe(result.name);
    expect(result.initialPrompt).toBe("🔥🔥🔥");
  });

  test("suffixes default timestamp names when another environment already uses the same timestamp", async () => {
    const existing = createEnvironment({
      id: "env-existing",
      name: "20260415-123456",
      branch: "20260415-123456",
    });
    const { context } = createContext(existing);
    const commands = createCommandRegistry();

    const result = await withFixedDate("2026-04-15T12:34:56.789Z", async () =>
      commands.get("create_environment")?.(
        {
          projectId: "project-1",
          environmentType: "local",
        },
        context,
      ) as Promise<Environment>,
    );

    expect(result.name).toBe("20260415-123456-1");
    expect(result.branch).toBe("20260415-123456-1");
  });

  test("suffixes explicit environment names when the current project already uses the slug", async () => {
    const existing = createEnvironment({
      id: "env-existing",
      name: "custom-name",
      branch: "custom-name",
    });
    const { context } = createContext(existing);
    const commands = createCommandRegistry();

    const result = await commands.get("create_environment")?.(
      {
        projectId: "project-1",
        name: "Custom Name",
        environmentType: "local",
      },
      context,
    ) as Environment;

    expect(result.name).toBe("custom-name-1");
    expect(result.branch).toBe("custom-name-1");
  });

  test("renames environments from prompts using codex exec output", async () => {
    const environment = createEnvironment({
      environmentType: "containerized",
      worktreePath: undefined,
      branch: "old-branch",
      prUrl: "https://github.com/acme/repo/pull/1",
      prState: "open",
      hasMergeConflicts: true,
    });
    const { context, emitted } = createContext(environment);
    const appRoot = await createTempDir("ork-electron-codex-app-");
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();

    await withFakeCodex(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CODEX_LOG"
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then
    out="$arg"
  fi
  prev="$arg"
done
[ -n "$out" ] || exit 2
printf '%s\\n' '{"slug":"Review OAuth Flow"}' > "$out"
`, async (logPath) => {
      await expect(commands.get("rename_environment_from_prompt")?.(
        { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
        context,
      )).resolves.toBeUndefined();

      expect(environment.name).toBe("review-oauth-flow");
      expect(environment.branch).toBe("review-oauth-flow");
      expect(environment.prUrl).toBeNull();
      expect(environment.prState).toBeNull();
      expect(environment.hasMergeConflicts).toBeNull();
      expect(emitted).toContainEqual({
        event: "environment-renamed",
        payload: {
          environment_id: environment.id,
          new_name: "review-oauth-flow",
          new_branch: "review-oauth-flow",
        },
      });

      const codexLog = await fs.readFile(logPath, "utf8");
      expect(codexLog).toContain("exec --skip-git-repo-check --ephemeral --ignore-rules --config model_reasoning_effort=\"low\" --sandbox read-only");
      expect(codexLog).toContain("--output-last-message");
      expect(codexLog).not.toContain("claude");
    });
  });

  test("suffixes prompt-renamed environments when another environment already uses the generated slug", async () => {
    const environment = createEnvironment({
      id: "env-new",
      name: "20260415-123456",
      branch: "20260415-123456",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: null,
      status: "stopped",
    });
    const existing = createEnvironment({
      id: "env-existing",
      name: "review-oauth-flow",
      branch: "review-oauth-flow",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: null,
      status: "stopped",
    });
    const { context, emitted } = createContext([environment, existing]);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(codexSlugScript("Review OAuth Flow"), async () => {
      await expect(commands.get("rename_environment_from_prompt")?.(
        { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
        context,
      )).resolves.toBeUndefined();

      expect(environment.name).toBe("review-oauth-flow-1");
      expect(environment.branch).toBe("review-oauth-flow-1");
      expect(existing.name).toBe("review-oauth-flow");
      expect(existing.branch).toBe("review-oauth-flow");
      expect(emitted).toContainEqual({
        event: "environment-renamed",
        payload: { environment_id: environment.id, new_name: "review-oauth-flow-1", new_branch: "review-oauth-flow-1" },
      });
    });
  });

  test("suffixes prompt-renamed local environments when the project already has the generated branch", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await runGit(worktree, ["branch", "review-oauth-flow"]);
    const environment = createEnvironment({
      id: "env-new",
      name: "20260415-123456",
      branch: "20260415-123456",
      environmentType: "local",
      worktreePath: undefined,
      containerId: null,
      status: "stopped",
    });
    const { context } = createContext(environment, {
      project: {
        id: "project-1",
        name: "repo",
        gitUrl: "https://github.com/acme/repo.git",
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
    });
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(codexSlugScript("Review OAuth Flow"), async () => {
      await expect(commands.get("rename_environment_from_prompt")?.(
        { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
        context,
      )).resolves.toBeUndefined();

      expect(environment.name).toBe("review-oauth-flow-1");
      expect(environment.branch).toBe("review-oauth-flow-1");
    });
  });

  test("renames the live local git branch and advances stored branch on success", async () => {
    const worktreePath = await createGitRepoOnBranch("old-branch");
    const environment = createEnvironment({
      environmentType: "local",
      worktreePath,
      branch: "old-branch",
      prUrl: "https://github.com/acme/repo/pull/1",
      prState: "open",
      hasMergeConflicts: true,
    });
    const { context, emitted } = createContext(environment);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(codexSlugScript("Review OAuth Flow"), async () => {
      await expect(commands.get("rename_environment_from_prompt")?.(
        { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
        context,
      )).resolves.toBeUndefined();

      expect(environment.name).toBe("review-oauth-flow");
      expect(environment.branch).toBe("review-oauth-flow");
      expect(environment.prUrl).toBeNull();
      expect(environment.prState).toBeNull();
      expect(environment.hasMergeConflicts).toBeNull();
      expect(await currentGitBranch(worktreePath)).toBe("review-oauth-flow");
      expect(emitted).toContainEqual({
        event: "environment-renamed",
        payload: { environment_id: environment.id, new_name: "review-oauth-flow", new_branch: "review-oauth-flow" },
      });
    });
  });

  test("renames the running container git branch and advances stored branch", async () => {
    const environment = createEnvironment({
      id: "env-container-rename",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
      pendingAgentLaunch: true,
      initialAgentModel: "gpt-5.6-sol",
      initialReasoningEffort: "high",
      branch: "old-branch",
      prUrl: "https://github.com/acme/repo/pull/1",
      prState: "open",
      hasMergeConflicts: true,
    });
    const { context } = createContext(environment);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(codexSlugScript("Review OAuth Flow"), async () => {
      await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "exec" ]; then
  printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
fi
exit 0
`, async (logs) => {
        await expect(commands.get("rename_environment_from_prompt")?.(
          { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
          context,
        )).resolves.toBeUndefined();

        expect(environment.name).toBe("review-oauth-flow");
        expect(environment.branch).toBe("review-oauth-flow");
        expect(environment.prUrl).toBeNull();

        const execLog = await fs.readFile(logs.exec, "utf8");
        expect(execLog).toContain("git -C /workspace branch -m -- 'old-branch' 'review-oauth-flow'");
      });
    });
  });

  test("keeps stored branch and PR metadata when the live git branch rename fails", async () => {
    // worktreePath is a plain directory (not a git repo) so `git branch -m` fails.
    const worktreePath = await createTempDir("ork-electron-rename-nonrepo-");
    const environment = createEnvironment({
      environmentType: "local",
      worktreePath,
      branch: "old-branch",
      prUrl: "https://github.com/acme/repo/pull/1",
      prState: "open",
      hasMergeConflicts: true,
    });
    const { context, emitted, updates } = createContext(environment);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(codexSlugScript("Review OAuth Flow"), async () => {
      await expect(commands.get("rename_environment_from_prompt")?.(
        { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
        context,
      )).resolves.toBeUndefined();

      // Display name advances, but the branch and PR metadata stay put (no divergence).
      expect(environment.name).toBe("review-oauth-flow");
      expect(environment.branch).toBe("old-branch");
      expect(environment.prUrl).toBe("https://github.com/acme/repo/pull/1");
      expect(environment.prState).toBe("open");
      expect(environment.hasMergeConflicts).toBe(true);
      expect(updates).toEqual([{ name: "review-oauth-flow" }]);
      expect(emitted).toContainEqual({
        event: "environment-renamed",
        payload: { environment_id: environment.id, new_name: "review-oauth-flow", new_branch: "old-branch" },
      });
    });
  });

  test("rejects renaming from an empty prompt without touching storage", async () => {
    const environment = createEnvironment({ environmentType: "local", worktreePath: undefined });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();

    await expect(commands.get("rename_environment_from_prompt")?.(
      { environmentId: environment.id, prompt: "   " },
      context,
    )).rejects.toThrow("Prompt cannot be empty");
    expect(updates).toHaveLength(0);
  });

  test("surfaces codex failures during rename", async () => {
    const environment = createEnvironment({ environmentType: "local", worktreePath: undefined });
    const { context, updates } = createContext(environment);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(`#!/bin/sh
printf 'codex auth required\\n' >&2
exit 1
`, async () => {
      await expect(commands.get("rename_environment_from_prompt")?.(
        { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
        context,
      )).rejects.toThrow("codex auth required");
      expect(updates).toHaveLength(0);
    });
  });

  test("rejects when codex output has no extractable slug", async () => {
    const environment = createEnvironment({ environmentType: "local", worktreePath: undefined });
    const { context, updates } = createContext(environment);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(`#!/bin/sh
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$arg"; fi
  prev="$arg"
done
[ -n "$out" ] || exit 2
printf '%s\\n' '{}' > "$out"
`, async () => {
      await expect(commands.get("rename_environment_from_prompt")?.(
        { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
        context,
      )).rejects.toThrow("Could not extract slug");
      expect(updates).toHaveLength(0);
    });
  });

  test("rejects when codex slug sanitizes to an empty name", async () => {
    const environment = createEnvironment({ environmentType: "local", worktreePath: undefined });
    const { context, updates } = createContext(environment);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(codexSlugScript("###"), async () => {
      await expect(commands.get("rename_environment_from_prompt")?.(
        { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
        context,
      )).rejects.toThrow("Generated name is empty");
      expect(updates).toHaveLength(0);
    });
  });

  test("keeps running local environments running during status sync", async () => {
    const environment = createEnvironment({ status: "running", containerId: null, environmentType: "local" });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();

    await expect(commands.get("get_environment_status")?.({ environmentId: environment.id }, context)).resolves.toBe("running");
    await expect(commands.get("get_environments")?.({ projectId: environment.projectId }, context)).resolves.toEqual([toClientEnvironment(environment)]);
    expect(updates).toHaveLength(0);
  });

  test("returns read-only environment snapshots without invoking Docker reconciliation", async () => {
    const environment = createEnvironment({
      status: "running",
      containerId: "container-existing",
      environmentType: "containerized",
      opencodePid: 40,
      claudeBridgePid: 41,
      codexBridgePid: 42,
      claudeModelCatalog: {
        environmentId: "env-1",
        models: [],
        source: "sdk",
        fetchedAt: new Date().toISOString(),
        stale: false,
      },
      agentActivitySources: {
        frontend: {
          state: "working",
          updatedAt: new Date().toISOString(),
        },
      },
      frontendAgentActivityObservers: {
        observer: {
          state: "working",
          updatedAt: new Date().toISOString(),
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
      pendingRenamePrompt: "private launch instruction",
      pendingAgentLaunch: false,
      initialAgentModel: "launch-only-model",
      initialReasoningEffort: "high",
      initialPromptAttachments: [{
        id: "image-1",
        name: "private.png",
        base64Data: "cHJpdmF0ZQ==",
      }],
    });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();

    const snapshots = await commands.get("get_environment_snapshots")?.(
      { projectId: environment.projectId },
      context,
    ) as Array<Record<string, unknown>>;
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      id: environment.id,
      projectId: environment.projectId,
      status: "running",
    });
    for (const field of [
      "opencodePid",
      "claudeBridgePid",
      "codexBridgePid",
      "claudeModelCatalog",
      "agentActivitySources",
      "frontendAgentActivityObservers",
      "pendingRenamePrompt",
      "initialAgentModel",
      "initialReasoningEffort",
      "initialPromptAttachments",
    ]) {
      expect(snapshots[0]).not.toHaveProperty(field);
    }
    expect(updates).toHaveLength(0);
  });

  test("keeps detail reads authoritative while projecting renderer mutation responses", async () => {
    const environment = createEnvironment({
      status: "running",
      environmentType: "local",
      opencodePid: 40,
      claudeBridgePid: 41,
      codexBridgePid: 42,
      pendingRenamePrompt: "backend-owned rename prompt",
      pendingAgentLaunch: true,
      initialAgentModel: "launch-model",
      initialReasoningEffort: "high",
      initialPromptAttachments: [{
        id: "image-1",
        name: "private.png",
        base64Data: "cHJpdmF0ZQ==",
      }],
      agentActivitySources: {
        frontend: {
          state: "working",
          updatedAt: new Date().toISOString(),
        },
      },
      frontendAgentActivityObservers: {
        observer: {
          state: "working",
          updatedAt: new Date().toISOString(),
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    });
    const { context } = createContext(environment);
    const storage = context.storage as unknown as {
      reorderEnvironments: ReturnType<typeof mock>;
      acknowledgeStartupAgentSession: ReturnType<typeof mock>;
      setEnvironmentUnread: ReturnType<typeof mock>;
    };
    storage.reorderEnvironments = mock(async () => [environment]);
    storage.acknowledgeStartupAgentSession = mock(async () => environment);
    storage.setEnvironmentUnread = mock(async () => environment);
    const commands = createCommandRegistry();
    const backendOnlyFields = [
      "opencodePid",
      "claudeBridgePid",
      "codexBridgePid",
      "claudeModelCatalog",
      "agentActivitySources",
      "frontendAgentActivityObservers",
      "pendingRenamePrompt",
      "initialPromptAttachments",
    ];
    const expectProjected = (value: unknown) => {
      for (const field of backendOnlyFields) {
        expect(value).not.toHaveProperty(field);
      }
    };

    const detail = await commands.get("get_environment")?.(
      { environmentId: environment.id },
      context,
    );
    expect(detail).toBe(environment);
    expect(detail).toHaveProperty("initialPromptAttachments");
    expect(detail).toHaveProperty("pendingRenamePrompt");

    const reordered = await commands.get("reorder_environments")?.(
      { projectId: environment.projectId, environmentIds: [environment.id] },
      context,
    ) as unknown[];
    expectProjected(reordered[0]);

    const responses = [
      await commands.get("sync_environment_status")?.(
        { environmentId: environment.id },
        context,
      ),
      await commands.get("rename_environment")?.(
        { environmentId: environment.id, name: "renamed" },
        context,
      ),
      await commands.get("set_environment_pr")?.(
        {
          environmentId: environment.id,
          prUrl: "https://example.invalid/pull/1",
          prState: "open",
          hasMergeConflicts: false,
        },
        context,
      ),
      await commands.get("set_environment_setup_complete")?.(
        { environmentId: environment.id, complete: false },
        context,
      ),
      await commands.get("update_port_mappings")?.(
        { environmentId: environment.id, portMappings: [] },
        context,
      ),
      await commands.get("update_environment_agent_settings")?.(
        {
          environmentId: environment.id,
          pendingAgentLaunch: true,
          initialPromptAttachments: environment.initialPromptAttachments,
        },
        context,
      ),
      await commands.get("set_environment_pending_agent_launch")?.(
        { environmentId: environment.id, pending: true },
        context,
      ),
      await commands.get("acknowledge_startup_agent_session")?.(
        { environmentId: environment.id },
        context,
      ),
      await commands.get("set_environment_initial_prompt")?.(
        {
          environmentId: environment.id,
          initialPrompt: "updated",
          initialPromptAttachments: environment.initialPromptAttachments,
        },
        context,
      ),
      await commands.get("update_environment_allowed_domains")?.(
        { environmentId: environment.id, domains: ["example.invalid"] },
        context,
      ),
      await commands.get("set_environment_unread")?.(
        { environmentId: environment.id, unread: false },
        context,
      ),
    ];
    for (const response of responses) expectProjected(response);
  });

  test("projects launch-only fields only while a launch remains pending", () => {
    const environment = createEnvironment({
      pendingAgentLaunch: false,
      initialAgentModel: "launch-model",
      initialReasoningEffort: "high",
    });
    expect(toClientEnvironment(environment)).not.toHaveProperty("initialAgentModel");
    expect(toClientEnvironment(environment)).not.toHaveProperty("initialReasoningEffort");

    environment.pendingAgentLaunch = true;
    expect(toClientEnvironment(environment)).toMatchObject({
      initialAgentModel: "launch-model",
      initialReasoningEffort: "high",
    });

    environment.pendingAgentLaunch = false;
    environment.startupAgentSession = {
      tabId: "startup-agent",
      agent: "codex",
      style: "native",
      status: "starting",
      startedAt: new Date().toISOString(),
    };
    expect(toClientEnvironment(environment)).toMatchObject({
      initialAgentModel: "launch-model",
      initialReasoningEffort: "high",
    });
  });

  /**
   * The bodies stay backend-only, but the renderer still has to know whether a
   * targeted detail read is worth making — and whether failing that read should
   * block a launch. `false` must be emitted, not omitted, so a client can tell
   * "this backend says there are none" apart from "this backend cannot say".
   */
  test("always reports whether stripped attachment bodies exist", () => {
    const withAttachments = createEnvironment({
      initialPromptAttachments: [{
        id: "image-1",
        name: "private.png",
        base64Data: "cHJpdmF0ZQ==",
      }],
    });
    expect(toClientEnvironment(withAttachments)).toMatchObject({
      hasInitialPromptAttachments: true,
    });
    expect(toClientEnvironment(withAttachments)).not.toHaveProperty(
      "initialPromptAttachments",
    );

    expect(toClientEnvironment(createEnvironment({})).hasInitialPromptAttachments)
      .toBe(false);
    expect(
      toClientEnvironment(createEnvironment({ initialPromptAttachments: [] }))
        .hasInitialPromptAttachments,
    ).toBe(false);
  });

  /**
   * The setup-start commands return the environment *nested* inside a result
   * object, so they need their own projection rather than inheriting the one
   * applied to the flat mutation responses.
   */
  test("projects the environment nested inside a setup-start result", async () => {
    const { worktree: worktreePath } = await createGitWorktreeWithOrigin();
    const environment = createEnvironment({
      id: "env-setup-start-projection",
      status: "running",
      environmentType: "local",
      worktreePath,
      containerId: null,
      setupScriptsComplete: false,
      opencodePid: 40,
      pendingRenamePrompt: "backend-owned rename prompt",
      initialPromptAttachments: [{
        id: "image-1",
        name: "private.png",
        base64Data: "cHJpdmF0ZQ==",
      }],
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    const result = await commands.get("ensure_environment_setup")?.(
      { environmentId: environment.id },
      context,
    ) as { environment: Record<string, unknown> };

    expect(result.environment).toMatchObject({ id: environment.id });
    for (const field of [
      "opencodePid",
      "pendingRenamePrompt",
      "initialPromptAttachments",
      "claudeModelCatalog",
      "agentActivitySources",
      "frontendAgentActivityObservers",
    ]) {
      expect(result.environment).not.toHaveProperty(field);
    }
    expect(result.environment.hasInitialPromptAttachments).toBe(true);
    // The stored record keeps everything the projection strips.
    expect((await context.storage.getEnvironment(environment.id))?.initialPromptAttachments)
      .toHaveLength(1);
  });

  test("passes an absent recreate result through without projecting it", async () => {
    const environment = createEnvironment({
      id: "env-recreate-no-container",
      status: "running",
      containerId: null,
      environmentType: "local",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    // A recreate with nothing to recreate has no result to project. Projecting
    // `undefined` would hand the renderer an object with no environment in it.
    await expect(commands.get("recreate_environment")?.(
      { environmentId: environment.id },
      context,
    )).resolves.toBeUndefined();
    await expect(commands.get("recreate_environment")?.(
      { environmentId: "missing-environment" },
      context,
    )).resolves.toBeUndefined();
  });

  test("records only newer environment activity timestamps", async () => {
    const environment = createEnvironment({
      lastActivityAt: "2026-07-22T10:00:00.000Z",
    });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();

    const activityUpdate = await commands.get("record_environment_activity")?.(
      { environmentId: environment.id, occurredAt: "2026-07-23T10:00:00.000Z" },
      context,
    ) as Record<string, unknown>;
    expect(activityUpdate).toMatchObject({
      id: environment.id,
      lastActivityAt: "2026-07-23T10:00:00.000Z",
    });
    expect(Object.keys(activityUpdate).sort()).toEqual([
      "agentActivityState",
      "agentActivityUpdatedAt",
      "hasUnreadWork",
      "id",
      "lastActivityAt",
    ]);
    expect(updates).toEqual([{ lastActivityAt: "2026-07-23T10:00:00.000Z" }]);

    await expect(commands.get("record_environment_activity")?.(
      { environmentId: environment.id, occurredAt: "2026-07-21T10:00:00.000Z" },
      context,
    )).resolves.toMatchObject({
      id: environment.id,
      lastActivityAt: "2026-07-23T10:00:00.000Z",
    });
    expect(updates).toHaveLength(1);

    await expect(commands.get("record_environment_activity")?.(
      { environmentId: environment.id, occurredAt: "2026-07-23T10:00:00.000Z" },
      context,
    )).resolves.toMatchObject({
      id: environment.id,
      lastActivityAt: "2026-07-23T10:00:00.000Z",
    });
    expect(updates).toHaveLength(1);

    await expect(commands.get("record_environment_activity")?.(
      { environmentId: environment.id, occurredAt: "not-a-date" },
      context,
    )).rejects.toThrow("occurredAt must be a valid ISO timestamp");

    await expect(commands.get("record_environment_activity")?.(
      { environmentId: "missing", occurredAt: "2026-07-24T10:00:00.000Z" },
      context,
    )).rejects.toThrow("Environment not found: missing");
  });

  test("preserves container identity when Docker status reconciliation fails transiently", async () => {
    const environment = createEnvironment({
      status: "running",
      containerId: "container-existing",
      environmentType: "containerized",
    });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\n' 'Cannot connect to the Docker daemon' >&2
exit 1
`, async () => {
      await expect(commands.get("get_environments")?.(
        { projectId: environment.projectId },
        context,
      )).resolves.toEqual([toClientEnvironment(environment)]);
    });

    expect(environment.containerId).toBe("container-existing");
    expect(environment.status).toBe("running");
    expect(updates).toHaveLength(0);
  });

  test("clears a container identity only when Docker confirms the container is absent", async () => {
    const environment = createEnvironment({
      status: "running",
      containerId: "container-missing",
      environmentType: "containerized",
    });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\n' 'Error: No such object: container-missing' >&2
exit 1
`, async () => {
      await commands.get("get_environments")?.({ projectId: environment.projectId }, context);
    });

    expect(environment.containerId).toBeNull();
    expect(environment.status).toBe("stopped");
    expect(updates).toContainEqual({ status: "stopped", containerId: null });
  });

  test("returns container workspace setup command from the backend setup plan", async () => {
    const environment = createEnvironment({
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: "container-1",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    const setupCommands = await commands.get("get_setup_commands")?.({ environmentId: environment.id }, context) as string[];
    expect(setupCommands).toHaveLength(1);
    expect(setupCommands[0]).toContain("/usr/local/bin/workspace-setup.sh");
    expect(setupCommands[0]).toContain("flock");
  });

  test("runs inactive container setup in the backend and persists completion", async () => {
    const environment = createEnvironment({
      id: "env-container-setup",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
    });
    const { context, emitted } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
  case "$*" in
    *ORKESTRATOR_SETUP_CAPABILITIES*)
      printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
      exit 0
      ;;
    *--prepare-only*)
      printf '\\036ORKESTRATOR_PREPARE_OK\\037'
      exit 0
      ;;
    *rev-parse*)
      printf '1111111111111111111111111111111111111111\\n'
      ;;
  esac
  exit 0
fi
exit 0
`, async (logs) => {
      const setupPromise = commands.get("run_environment_setup")?.({ environmentId: environment.id }, context) as Promise<Environment>;
      await waitForPtyProcessCount(1);
      ptyProcesses[0]?.emitData(SETUP_DONE_OSC);
      const updated = await setupPromise;

      expect(updated.setupScriptsComplete).toBe(true);
      expect(updated.createdFromCommit).toBe("1111111111111111111111111111111111111111");
      expect(environment.setupScriptsComplete).toBe(true);
      expect(environment.createdFromCommit).toBe("1111111111111111111111111111111111111111");
      const execLog = await fs.readFile(logs.exec, "utf8");
      expect(execLog).toContain("workspace-setup.sh --prepare-only");
      expect(execLog).toContain("git -C /workspace rev-parse --verify 'HEAD^{commit}'");
      expect(execLog.indexOf("workspace-setup.sh --prepare-only")).toBeLessThan(
        execLog.indexOf("git -C /workspace rev-parse --verify 'HEAD^{commit}'"),
      );
      expect(ptySpawn).toHaveBeenCalledWith(
        "docker",
        expect.arrayContaining([
          "exec",
          "-it",
          "container-1",
          "zsh",
          "-lc",
          expect.stringContaining("/usr/local/bin/workspace-setup.sh"),
        ]),
        expect.any(Object),
      );
      expect(ptySpawn.mock.calls[0]?.[1].at(-1)).toContain("flock");
      const setupOutput = emitted
        .filter((entry) => entry.event === `terminal-output-${environment.id}:setup`)
        .map((entry) => (entry.payload as { text: string }).text)
        .join("");
      expect(setupOutput).toContain("[orkestrator] Starting environment setup");
      expect(setupOutput).toContain("/usr/local/bin/workspace-setup.sh");
      const setupStarted = emitted
        .filter((entry) => entry.event === "environment-setup-started")
        .at(-1)?.payload;
      expect(setupStarted).toMatchObject({
        environment_id: environment.id,
        session_id: `${environment.id}:setup`,
        environment: {
          id: environment.id,
          setupScriptsComplete: false,
          createdFromCommit: environment.createdFromCommit,
        },
      });
      const setupComplete = emitted.find(
        (entry) => entry.event === "environment-setup-complete",
      )?.payload;
      expect(setupComplete).toMatchObject({
        environment_id: environment.id,
        success: true,
        environment: {
          id: updated.id,
          setupScriptsComplete: true,
          createdFromCommit: updated.createdFromCommit,
        },
      });
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("retries container baseline capture before any setup command runs", async () => {
    const environment = createEnvironment({
      id: "env-container-baseline-retry",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  case "$*" in
    *ORKESTRATOR_SETUP_CAPABILITIES*)
      printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
      exit 0
      ;;
    *--prepare-only*)
      printf '\\036ORKESTRATOR_PREPARE_OK\\037'
      exit 0
      ;;
    *--prepare-only*)
      exit 0
      ;;
    *rev-parse*)
      if [ ! -f "$FAKE_DOCKER_LOG.capture-failed" ]; then
        touch "$FAKE_DOCKER_LOG.capture-failed"
        printf 'transient capture failure\\n' >&2
        exit 1
      fi
      printf '4444444444444444444444444444444444444444\\n'
      exit 0
      ;;
  esac
fi
exit 0
`, async (logs) => {
      await expect(commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      )).rejects.toThrow("transient capture failure");
      expect(ptySpawn).not.toHaveBeenCalled();
      expect(environment.setupScriptsComplete).toBe(false);
      expect(environment.createdFromCommit).toBeUndefined();

      const retry = commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<Environment>;
      await waitForPtyProcessCount(1);
      expect(environment.createdFromCommit).toBe("4444444444444444444444444444444444444444");
      expect(environment.setupScriptsComplete).toBe(false);
      ptyProcesses[0]?.emitData(SETUP_DONE_OSC);
      await expect(retry).resolves.toMatchObject({
        createdFromCommit: "4444444444444444444444444444444444444444",
        setupScriptsComplete: true,
      });

      const execLog = await fs.readFile(logs.exec, "utf8");
      expect(execLog.split("\n").filter((line) => line.includes("workspace-setup.sh --prepare-only"))).toHaveLength(2);
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("rejects an invalid container HEAD without starting setup", async () => {
    const environment = createEnvironment({
      id: "env-container-invalid-head",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  case "$*" in
    *ORKESTRATOR_SETUP_CAPABILITIES*)
      printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
      exit 0
      ;;
    *--prepare-only*)
      printf '\\036ORKESTRATOR_PREPARE_OK\\037'
      exit 0
      ;;
    *rev-parse*) printf 'not-a-commit\\n' ;;
  esac
  exit 0
fi
exit 0
`, async () => {
      await expect(commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      )).rejects.toThrow("Could not resolve environment creation commit");
      expect(ptySpawn).not.toHaveBeenCalled();
      expect(environment.setupScriptsComplete).toBe(false);
      expect(environment.createdFromCommit).toBeUndefined();
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("preserves an existing baseline without preparing or recapturing HEAD", async () => {
    const originalCommit = "7777777777777777777777777777777777777777";
    const environment = createEnvironment({
      id: "env-container-existing-baseline",
      environmentType: "containerized",
      setupScriptsComplete: false,
      createdFromCommit: originalCommit,
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
exit 0
`, async (logs) => {
      const setup = commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<Environment>;
      await waitForPtyProcessCount(1);
      ptyProcesses[0]?.emitData(SETUP_DONE_OSC);
      await expect(setup).resolves.toMatchObject({
        createdFromCommit: originalCommit,
        setupScriptsComplete: true,
      });

      const dockerLog = await fs.readFile(logs.all, "utf8");
      expect(dockerLog).not.toContain("--prepare-only");
      expect(dockerLog).not.toContain("rev-parse");
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("preserves a running environment and pending launch when setup fails before publishing an attempt", async () => {
    const worktreePath = await createTempDir("ork-electron-setup-invalid-config-");
    await fs.writeFile(path.join(worktreePath, "orkestrator-ai.json"), "{ invalid json");
    const environment = createEnvironment({
      id: "env-local-invalid-setup-config",
      environmentType: "local",
      setupScriptsComplete: false,
      setupPhase: "pending",
      createdFromCommit: "7878787878787878787878787878787878787878",
      worktreePath,
      containerId: null,
      status: "running",
      pendingAgentLaunch: true,
      initialAgentModel: "model-1",
      initialReasoningEffort: "high",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await expect(commands.get("run_environment_setup")?.(
      { environmentId: environment.id },
      context,
    )).rejects.toThrow();

    expect(ptySpawn).not.toHaveBeenCalled();
    expect(environment).toMatchObject({
      status: "running",
      setupScriptsComplete: false,
      setupPhase: "failed",
      pendingAgentLaunch: true,
      initialAgentModel: "model-1",
      initialReasoningEffort: "high",
    });
  });

  test("closes a retry session when its container is stopped, then allows a healthy retry", async () => {
    const environment = createEnvironment({
      id: "env-container-stopped-retry",
      environmentType: "containerized",
      setupScriptsComplete: false,
      createdFromCommit: "8888888888888888888888888888888888888888",
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const setupSessionId = `${environment.id}:setup`;

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "inspect" ]; then
  if [ -f "$FAKE_DOCKER_LOG.healthy" ]; then
    printf 'running\\n'
  else
    printf 'exited\\n'
  fi
  exit 0
fi
exit 0
`, async (logs) => {
      await expect(commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      )).rejects.toThrow("Container is not running");

      expect(
        await commands.get("get_environment_setup_session")?.(
          { environmentId: environment.id },
          context,
        ),
      ).toEqual(expect.objectContaining({
        sessionId: setupSessionId,
        running: false,
        terminalRunning: false,
        success: false,
      }));
      expect(
        commands.get("get_terminal_session")?.({ sessionId: setupSessionId }, context),
      ).toEqual({ id: setupSessionId, running: false });
      expect(ptySpawn).not.toHaveBeenCalled();
      expect(environment).toMatchObject({
        status: "error",
        setupPhase: "failed",
      });

      await fs.writeFile(`${logs.all}.healthy`, "");
      const retry = commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<Environment>;
      await waitForPtyProcessCount(1);
      expect(
        commands.get("get_terminal_session")?.({ sessionId: setupSessionId }, context),
      ).toEqual({ id: setupSessionId, running: true });
      expect(environment).toMatchObject({
        status: "running",
        setupPhase: "running",
        lifecycleError: null,
      });
      ptyProcesses[0]?.emitData(SETUP_DONE_OSC);
      await expect(retry).resolves.toMatchObject({
        status: "running",
        setupScriptsComplete: true,
        setupPhase: "ready",
        lifecycleError: null,
      });
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("closes a retry session when PTY spawn throws, then allows a healthy retry", async () => {
    const environment = createEnvironment({
      id: "env-container-pty-spawn-retry",
      environmentType: "containerized",
      setupScriptsComplete: false,
      createdFromCommit: "9999999999999999999999999999999999999999",
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const setupSessionId = `${environment.id}:setup`;

    ptySpawn.mockImplementationOnce(() => {
      throw new Error("PTY spawn unavailable");
    });
    await withFakeDocker(RUNNING_CONTAINER_DOCKER_SCRIPT, async () => {
      await expect(commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      )).rejects.toThrow("PTY spawn unavailable");

      expect(
        await commands.get("get_environment_setup_session")?.(
          { environmentId: environment.id },
          context,
        ),
      ).toEqual(expect.objectContaining({
        sessionId: setupSessionId,
        running: false,
        terminalRunning: false,
        success: false,
      }));
      expect(
        commands.get("get_terminal_session")?.({ sessionId: setupSessionId }, context),
      ).toEqual({ id: setupSessionId, running: false });

      const retry = commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<Environment>;
      await waitForPtyProcessCount(1);
      ptyProcesses[0]?.emitData(SETUP_DONE_OSC);
      await expect(retry).resolves.toMatchObject({ setupScriptsComplete: true });
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("closes a retry session when a local worktree disappears before PTY spawn", async () => {
    const worktreePath = await createTempDir("ork-electron-setup-worktree-race-");
    const missingWorktreePath = `${worktreePath}-missing`;
    await fs.writeFile(
      path.join(worktreePath, "orkestrator-ai.json"),
      JSON.stringify({ setupLocal: "printf setup" }),
    );
    const environment = createEnvironment({
      id: "env-local-missing-worktree-retry",
      environmentType: "local",
      setupScriptsComplete: false,
      createdFromCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      worktreePath,
      containerId: null,
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const setupSessionId = `${environment.id}:setup`;
    let worktreePathReads = 0;
    // Model a worktree deleted after its setup config was read but before
    // spawnSetupTerminal performs its final existence check. The setup path
    // reads this property while selecting and loading the config, then while
    // logging and validating the PTY target.
    Object.defineProperty(environment, "worktreePath", {
      configurable: true,
      get: () => {
        worktreePathReads += 1;
        return worktreePathReads <= 4 ? worktreePath : missingWorktreePath;
      },
    });

    await expect(commands.get("run_environment_setup")?.(
      { environmentId: environment.id },
      context,
    )).rejects.toThrow(`Local environment worktree does not exist: ${missingWorktreePath}`);

    expect(
      await commands.get("get_environment_setup_session")?.(
        { environmentId: environment.id },
        context,
      ),
    ).toEqual(expect.objectContaining({
      sessionId: setupSessionId,
      running: false,
      terminalRunning: false,
      success: false,
    }));
    expect(
      commands.get("get_terminal_session")?.({ sessionId: setupSessionId }, context),
    ).toEqual({ id: setupSessionId, running: false });
    expect(ptySpawn).not.toHaveBeenCalled();
  });

  test("a failed baseline storage write blocks setup and succeeds on retry", async () => {
    const environment = createEnvironment({
      id: "env-container-baseline-storage-retry",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
    });
    const { context, updates } = createContext(environment);
    let failBaselineWrite = true;
    context.storage.updateEnvironment = mock(async (
      environmentId: string,
      update: Partial<Environment>,
    ) => {
      if (environmentId !== environment.id) throw new Error(`Environment not found: ${environmentId}`);
      if (failBaselineWrite && update.createdFromCommit) {
        failBaselineWrite = false;
        throw new Error("baseline storage unavailable");
      }
      updates.push(update);
      Object.assign(environment, update);
      return environment;
    }) as typeof context.storage.updateEnvironment;
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  case "$*" in
    *ORKESTRATOR_SETUP_CAPABILITIES*)
      printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
      exit 0
      ;;
    *--prepare-only*)
      printf '\\036ORKESTRATOR_PREPARE_OK\\037'
      exit 0
      ;;
    *rev-parse*) printf '5555555555555555555555555555555555555555\\n' ;;
  esac
  exit 0
fi
exit 0
`, async () => {
      await expect(commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      )).rejects.toThrow("baseline storage unavailable");
      expect(ptySpawn).not.toHaveBeenCalled();
      expect(environment.setupScriptsComplete).toBe(false);

      const retry = commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<Environment>;
      await waitForPtyProcessCount(1);
      ptyProcesses[0]?.emitData(SETUP_DONE_OSC);
      await expect(retry).resolves.toMatchObject({
        createdFromCommit: "5555555555555555555555555555555555555555",
        setupScriptsComplete: true,
      });
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("serializes concurrent setup starts through one preparation and PTY", async () => {
    const environment = createEnvironment({
      id: "env-container-concurrent-setup",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  case "$*" in
    *ORKESTRATOR_SETUP_CAPABILITIES*)
      printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
      exit 0
      ;;
    *--prepare-only*)
      printf '\\036ORKESTRATOR_PREPARE_OK\\037'
      exit 0
      ;;
    *rev-parse*) printf '6666666666666666666666666666666666666666\\n' ;;
  esac
  exit 0
fi
exit 0
`, async (logs) => {
      const first = commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<Environment>;
      const second = commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<Environment>;
      await waitForPtyProcessCount(1);
      expect(ptySpawn).toHaveBeenCalledTimes(1);
      ptyProcesses[0]?.emitData(SETUP_DONE_OSC);
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);

      const execLog = await fs.readFile(logs.exec, "utf8");
      expect(execLog.split("\n").filter((line) => line.includes("workspace-setup.sh --prepare-only"))).toHaveLength(1);
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("returns completed container environments without rerunning backend setup", async () => {
    const environment = createEnvironment({
      id: "env-container-setup-complete",
      environmentType: "containerized",
      setupScriptsComplete: true,
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
    });
    const { context, emitted } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
exit 1
`, async () => {
      const result = await commands.get("run_environment_setup")?.({ environmentId: environment.id }, context);

      expect(result).toEqual(toClientEnvironment(environment));
      expect(emitted).toEqual([]);
    });
  });

  test("ensures no-op local setup without spawning a terminal", async () => {
    const { worktree: worktreePath } = await createGitWorktreeWithOrigin();
    const environment = createEnvironment({
      id: "env-local-noop-setup",
      environmentType: "local",
      setupScriptsComplete: false,
      worktreePath,
      containerId: null,
      status: "running",
    });
    const { context, emitted } = createContext(environment);
    const commands = createCommandRegistry();

    const result = await commands.get("ensure_environment_setup")?.({ environmentId: environment.id }, context);

    expect(result).toEqual(expect.objectContaining({
      setupStarted: false,
      environment: expect.objectContaining({
        id: environment.id,
        setupScriptsComplete: true,
      }),
    }));
    expect(environment.setupScriptsComplete).toBe(true);
    expect(ptySpawn).not.toHaveBeenCalled();
    expect(emitted).toContainEqual({
      event: "environment-setup-complete",
      payload: {
        environment_id: environment.id,
        success: true,
        environment: expect.objectContaining({
          id: environment.id,
          setupScriptsComplete: true,
        }),
      },
    });
  });

  test("spawns local setup commands in an interactive login PTY", async () => {
    const { worktree: worktreePath } = await createGitWorktreeWithOrigin();
    await fs.writeFile(
      path.join(worktreePath, "orkestrator-ai.json"),
      JSON.stringify({ setupLocal: ["bun install", "bun run prepare"] }),
    );
    const environment = createEnvironment({
      id: "env-local-setup-terminal",
      environmentType: "local",
      setupScriptsComplete: false,
      worktreePath,
      containerId: null,
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    const setupPromise = commands.get("run_environment_setup")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<Environment>;
    await waitForPtyProcessCount(1);

    expect(ptySpawn.mock.calls[0]?.[0]).toBe(expectedLocalShellPath());
    expect(ptySpawn.mock.calls[0]?.[1]?.[0]).toBe("-ilc");
    expect(ptySpawn.mock.calls[0]?.[1]?.[1]).toContain(
      "bun install && bun run prepare",
    );
    expect(ptySpawn.mock.calls[0]?.[2]).toMatchObject({
      cwd: worktreePath,
      cols: 80,
      rows: 24,
    });

    ptyProcesses[0]?.emitData(SETUP_DONE_OSC);
    await expect(setupPromise).resolves.toEqual(
      expect.objectContaining({ setupScriptsComplete: true }),
    );
  }, ASYNC_TEST_BUDGET_MS);

  test("emits a failure event when inactive container setup fails", async () => {
    const environment = createEnvironment({
      id: "env-container-setup-fails",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
      // Seed the launch intent *and* both one-shot options, otherwise the
      // "must not survive" assertions below are vacuously true.
      pendingAgentLaunch: true,
      initialAgentModel: "claude-fable-5[1m]",
      initialReasoningEffort: "max",
    });
    const { context, emitted } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "inspect" ]; then
  printf 'running\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  case "$*" in
    *ORKESTRATOR_SETUP_CAPABILITIES*)
      printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
      exit 0
      ;;
    *--prepare-only*)
      printf '\\036ORKESTRATOR_PREPARE_OK\\037'
      exit 0
      ;;
    *rev-parse*)
      printf '3333333333333333333333333333333333333333\n'
      ;;
  esac
  exit 0
fi
exit 0
`, async () => {
      const setupPromise = commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<Environment>;
      await waitForPtyProcessCount(1);
      ptyProcesses[0]?.emitData(SETUP_FAILED_OSC);
      await expect(setupPromise).rejects.toThrow("Setup script failed");

      expect(environment.setupScriptsComplete).toBe(false);
      expect(environment.status).toBe("error");
      expect(environment.lifecycleError).toBe(
        ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.setupScript,
      );
      const failure = emitted.find((entry) =>
        entry.event === "environment-setup-complete"
        && (entry.payload as { success?: boolean }).success === false
      );
      expect(failure?.payload).toMatchObject({
        environment_id: environment.id,
        success: false,
        error: "Setup script failed",
      });
      // A launch that can never be honoured must not survive the failure.
      expect(environment.pendingAgentLaunch).toBe(false);
      expect(environment.initialAgentModel).toBeUndefined();
      expect(environment.initialReasoningEffort).toBeUndefined();
      expect(
        (failure?.payload as { environment?: Environment }).environment?.pendingAgentLaunch,
      ).toBe(false);
      expect(
        (failure?.payload as { environment?: Environment }).environment?.initialAgentModel,
      ).toBeUndefined();
      expect(
        (failure?.payload as { environment?: Environment }).environment?.initialReasoningEffort,
      ).toBeUndefined();

      // A renderer may have been inactive when the one-shot event fired. The
      // failure must therefore survive a registry/backend reconstruction and be
      // available from an authoritative snapshot alone.
      const restartedRegistry = createCommandRegistry();
      await expect(restartedRegistry.get("get_environment_snapshots")?.(
        { projectId: environment.projectId },
        context,
      )).resolves.toEqual([
        expect.objectContaining({
          id: environment.id,
          status: "error",
          lifecycleError: ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.setupScript,
        }),
      ]);
      await expect(restartedRegistry.get("get_environments")?.(
        { projectId: environment.projectId },
        context,
      )).resolves.toEqual([
        expect.objectContaining({
          id: environment.id,
          status: "error",
          lifecycleError: ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.setupScript,
        }),
      ]);
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("completes setup when the done marker is split across PTY chunks", async () => {
    const environment = createEnvironment({
      id: "env-container-split-marker",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(RUNNING_CONTAINER_DOCKER_SCRIPT, async () => {
      const setupPromise = commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<Environment>;
      await waitForPtyProcessCount(1);
      // Deliver the completion marker split across two reads, mimicking how a
      // PTY can chunk output at an arbitrary boundary.
      const splitAt = Math.floor(SETUP_DONE_OSC.length / 2);
      ptyProcesses[0]?.emitData(SETUP_DONE_OSC.slice(0, splitAt));
      ptyProcesses[0]?.emitData(SETUP_DONE_OSC.slice(splitAt));
      const updated = await setupPromise;

      expect(updated.setupScriptsComplete).toBe(true);
      expect(environment.setupScriptsComplete).toBe(true);
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("fails setup when the PTY exits before reporting completion", async () => {
    const environment = createEnvironment({
      id: "env-container-early-exit",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
    });
    const { context, emitted } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(RUNNING_CONTAINER_DOCKER_SCRIPT, async () => {
      const setupPromise = commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<Environment>;
      await waitForPtyProcessCount(1);
      ptyProcesses[0]?.emitExit({ exitCode: 1 });
      await expect(setupPromise).rejects.toThrow("Setup terminal exited before reporting completion");

      expect(environment.setupScriptsComplete).toBe(false);
      expect(
        emitted.find((entry) =>
          entry.event === "environment-setup-complete"
          && (entry.payload as { success?: boolean }).success === false
        )?.payload,
      ).toMatchObject({
        environment_id: environment.id,
        success: false,
        error: "Setup terminal exited before reporting completion",
      });
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("retains the setup output buffer after the setup PTY exits", async () => {
    const environment = createEnvironment({
      id: "env-container-setup-buffer",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const setupSessionId = `${environment.id}:setup`;

    await withFakeDocker(RUNNING_CONTAINER_DOCKER_SCRIPT, async () => {
      const setupPromise = commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<Environment>;
      await waitForPtyProcessCount(1);
      ptyProcesses[0]?.emitData("configuring workspace...\r\n");
      ptyProcesses[0]?.emitData(SETUP_DONE_OSC);
      await setupPromise;

      const buffer = await commands.get("get_terminal_output_buffer")?.(
        { sessionId: setupSessionId },
        context,
      ) as string;
      expect(buffer).toContain("[orkestrator] Starting environment setup");
      expect(buffer).toContain("configuring workspace...");

      // Setup buffers are intentionally retained after the PTY exits so the
      // renderer can still replay them when it reattaches.
      ptyProcesses[0]?.emitExit({ exitCode: 0 });
      const afterExit = await commands.get("get_terminal_output_buffer")?.(
        { sessionId: setupSessionId },
        context,
      ) as string;
      expect(afterExit).toContain("configuring workspace...");
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("reports backend setup session state via get_environment_setup_session", async () => {
    const environment = createEnvironment({
      id: "env-container-setup-session",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    expect(
      await commands.get("get_environment_setup_session")?.({ environmentId: environment.id }, context),
    ).toBeNull();

    await withFakeDocker(RUNNING_CONTAINER_DOCKER_SCRIPT, async () => {
      const setupPromise = commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<Environment>;
      await waitForPtyProcessCount(1);

      const runningSession = await commands.get("get_environment_setup_session")?.(
        { environmentId: environment.id },
        context,
      );
      expect(runningSession).toEqual(expect.objectContaining({
        environmentId: environment.id,
        sessionId: `${environment.id}:setup`,
        running: true,
        terminalRunning: true,
      }));

      ptyProcesses[0]?.emitData(SETUP_DONE_OSC);
      await setupPromise;

      const completedSession = await commands.get("get_environment_setup_session")?.(
        { environmentId: environment.id },
        context,
      );
      // Setup is marked complete via the OSC marker while the PTY stays alive as
      // the interactive shell, so the session reports done but still running.
      expect(completedSession).toEqual(expect.objectContaining({
        running: false,
        success: true,
        terminalRunning: true,
      }));

      ptyProcesses[0]?.emitExit({ exitCode: 0 });
      expect(
        await commands.get("get_environment_setup_session")?.(
          { environmentId: environment.id },
          context,
        ),
      ).toEqual(expect.objectContaining({
        running: false,
        success: true,
        terminalRunning: false,
      }));
      expect(
        commands.get("get_terminal_session")?.(
          { sessionId: `${environment.id}:setup` },
          context,
        ),
      ).toEqual({ id: `${environment.id}:setup`, running: false });
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("clears retained setup state when the environment is deleted", async () => {
    const environment = createEnvironment({
      id: "env-container-setup-delete",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const setupSessionId = `${environment.id}:setup`;
    const retainedStableTerminal = terminalSessionResult(
      await commands.get("create_local_terminal_session")?.(
        {
          environmentId: environment.id,
          terminalKey: "retained-tab",
          cols: 80,
          rows: 24,
        },
        context,
      ),
    );

    await withFakeDocker(RUNNING_CONTAINER_DOCKER_SCRIPT, async () => {
      const setupPromise = commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<Environment>;
      await waitForPtyProcessCount(1);
      ptyProcesses[0]?.emitData(SETUP_DONE_OSC);
      await setupPromise;

      expect(
        await commands.get("get_environment_setup_session")?.({ environmentId: environment.id }, context),
      ).not.toBeNull();

      await commands.get("delete_environment")?.({ environmentId: environment.id }, context);

      expect(context.storage.deleteLoopedReviewWorkflowsByEnvironment)
        .toHaveBeenCalledWith(environment.id);
      expect(context.storage.deleteNativeAgentSessionsByEnvironment)
        .toHaveBeenCalledWith(environment.id);
      expect(context.storage.deletePaneLayout).toHaveBeenCalledWith(environment.id);

      expect(
        await commands.get("get_environment_setup_session")?.({ environmentId: environment.id }, context),
      ).toBeNull();
      const buffer = await commands.get("get_terminal_output_buffer")?.(
        { sessionId: setupSessionId },
        context,
      ) as string;
      expect(buffer).toBe("");

      expect(commands.get("get_terminal_output_snapshot")?.(
        { sessionId: retainedStableTerminal.sessionId },
        context,
      )).toEqual({ output: "", revision: 0, generation: 0, truncated: false });
      const recreated = terminalSessionResult(
        await commands.get("create_local_terminal_session")?.(
          {
            environmentId: environment.id,
            terminalKey: "retained-tab",
            cols: 80,
            rows: 24,
          },
          context,
        ),
      );
      expect(recreated.created).toBe(true);
      expect(recreated.sessionId).not.toBe(retainedStableTerminal.sessionId);
      commands.get("close_local_terminal_session")?.(
        { sessionId: recreated.sessionId },
        context,
      );
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("retains an exited terminal snapshot long enough for desync recovery", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-buffer-");
    const environment = createEnvironment({
      id: "env-local-terminal-buffer",
      environmentType: "local",
      worktreePath,
      containerId: null,
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      { environmentId: environment.id, cols: 80, rows: 24 },
      context,
    )).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);
    await waitForPtyProcessCount(1);

    ptyProcesses[0]?.emitData("hello from shell\r\n");
    const buffer = await commands.get("get_terminal_output_buffer")?.({ sessionId }, context) as string;
    expect(buffer).toContain("hello from shell");

    const beforeExit = await commands.get("get_terminal_output_snapshot")?.(
      { sessionId },
      context,
    );
    ptyProcesses[0]?.emitExit({ exitCode: 0 });
    expect(
      await commands.get("get_terminal_output_snapshot")?.({ sessionId }, context),
    ).toEqual(beforeExit);
    expect(commandTesting.retainedTerminalOutputBufferCount()).toBe(1);

    // Retention is bounded in time; pin the expiry result without making the
    // suite sleep for the production recovery window.
    commandTesting.deleteRetainedTerminalOutputBuffer(sessionId);
    expect(
      await commands.get("get_terminal_output_snapshot")?.({ sessionId }, context),
    ).toEqual({ output: "", revision: 0, generation: 0, truncated: false });
    expect(commandTesting.retainedTerminalOutputBufferCount()).toBe(0);
  }, ASYNC_TEST_BUDGET_MS);

  test("returns terminal deltas and falls back across output generations", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-delta-");
    const environment = createEnvironment({
      id: "env-local-terminal-delta",
      environmentType: "local",
      worktreePath,
      containerId: null,
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const sessionId = terminalSessionResult(
      await commands.get("create_local_terminal_session")?.(
        { environmentId: environment.id, cols: 80, rows: 24 },
        context,
      ),
    ).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);
    await waitForPtyProcessCount(1);
    ptyProcesses[0]?.emitData("first");
    ptyProcesses[0]?.emitData(" second");

    expect(commands.get("get_terminal_output_snapshot")?.({
      sessionId,
      sinceRevision: 0,
      sinceGeneration: 1,
    }, context)).toEqual({
      mode: "delta",
      output: "first second",
      deltas: [
        { revision: 1, text: "first" },
        { revision: 2, text: " second" },
      ],
      revision: 2,
      generation: 1,
      truncated: false,
    });
    expect(commands.get("get_terminal_output_snapshot")?.({
      sessionId,
      sinceRevision: 1,
      sinceGeneration: 1,
    }, context)).toEqual({
      mode: "delta",
      output: " second",
      deltas: [{ revision: 2, text: " second" }],
      revision: 2,
      generation: 1,
      truncated: false,
    });
    expect(commands.get("get_terminal_output_snapshot")?.({
      sessionId,
      sinceRevision: 2,
      sinceGeneration: 1,
    }, context)).toEqual({
      mode: "delta",
      output: "",
      deltas: [],
      revision: 2,
      generation: 1,
      truncated: false,
    });
    expect(commands.get("get_terminal_output_snapshot")?.({
      sessionId,
      sinceRevision: 1,
      sinceGeneration: 0,
    }, context)).toMatchObject({
      mode: "full",
      reason: "generation-changed",
      output: "first second",
      revision: 2,
      generation: 1,
    });

    // The terminal WebSocket acknowledges writes, so a write that never reached
    // a shell has to be distinguishable from one that did. Reporting it as
    // delivered would tell the user a keystroke landed in a dead terminal.
    expect(commands.get("terminal_write")?.({ sessionId, data: "x" }, context))
      .toEqual({ delivered: true });
    expect(commands.get("terminal_resize")?.({ sessionId, cols: 80, rows: 24 }, context))
      .toEqual({ delivered: true });
    expect(commands.get("terminal_write")?.({ sessionId: "missing-session", data: "x" }, context))
      .toEqual({ delivered: false });
    expect(commands.get("terminal_resize")?.({ sessionId: "missing-session", cols: 80, rows: 24 }, context))
      .toEqual({ delivered: false });
    expect(commands.get("local_terminal_write")?.({ sessionId: "missing-session", data: "x" }, context))
      .toEqual({ delivered: false });
    expect(commands.get("local_terminal_resize")?.({
      sessionId: "missing-session", cols: 80, rows: 24,
    }, context)).toEqual({ delivered: false });
    for (let index = 0; index < 1_025; index += 1) {
      ptyProcesses[0]?.emitData("x");
    }
    expect(commands.get("get_terminal_output_snapshot")?.({
      sessionId,
      sinceRevision: 2,
      sinceGeneration: 1,
    }, context)).toMatchObject({
      mode: "full",
      reason: "expired",
      revision: 1_027,
      generation: 1,
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("expires an exited terminal snapshot through the production timer path", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-buffer-expiry-");
    const environment = createEnvironment({
      id: "env-local-terminal-buffer-expiry",
      environmentType: "local",
      worktreePath,
      containerId: null,
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    commandTesting.setTerminalOutputRetentionMs(5);

    const sessionId = terminalSessionResult(
      await commands.get("create_local_terminal_session")?.(
        { environmentId: environment.id, cols: 80, rows: 24 },
        context,
      ),
    ).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);
    ptyProcesses.at(-1)?.emitData("short-lived tail");
    ptyProcesses.at(-1)?.emitExit({ exitCode: 0 });
    expect(commandTesting.retainedTerminalOutputBufferCount()).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(commandTesting.retainedTerminalOutputBufferCount()).toBe(0);
    expect(commands.get("get_terminal_output_snapshot")?.({ sessionId }, context))
      .toEqual({ output: "", revision: 0, generation: 0, truncated: false });
  }, ASYNC_TEST_BUDGET_MS);

  test("an explicitly closed terminal does not retain its output snapshot", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-explicit-close-");
    const environment = createEnvironment({
      id: "env-local-terminal-explicit-close",
      environmentType: "local",
      worktreePath,
      containerId: null,
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    const sessionId = terminalSessionResult(
      await commands.get("create_local_terminal_session")?.(
        { environmentId: environment.id, cols: 80, rows: 24 },
        context,
      ),
    ).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);
    ptyProcesses.at(-1)?.emitData("user closed this terminal");

    await commands.get("close_local_terminal_session")?.({ sessionId }, context);

    expect(commandTesting.retainedTerminalOutputBufferCount()).toBe(0);
    expect(commands.get("get_terminal_output_snapshot")?.({ sessionId }, context))
      .toEqual({ output: "", revision: 0, generation: 0, truncated: false });
  }, ASYNC_TEST_BUDGET_MS);

  test("bounds retained exited terminal snapshots and evicts the oldest", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-retention-cap-");
    const environment = createEnvironment({
      id: "env-local-terminal-retention-cap",
      environmentType: "local",
      worktreePath,
      containerId: null,
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const sessionIds: string[] = [];

    for (let index = 0; index < 33; index += 1) {
      const sessionId = terminalSessionResult(
        await commands.get("create_local_terminal_session")?.(
          { environmentId: environment.id, cols: 80, rows: 24 },
          context,
        ),
      ).sessionId;
      sessionIds.push(sessionId);
      await commands.get("start_local_terminal_session")?.({ sessionId }, context);
      const process = ptyProcesses.at(-1)!;
      process.emitData(`snapshot-${index}`);
      process.emitExit({ exitCode: 0 });
    }

    expect(commandTesting.retainedTerminalOutputBufferCount()).toBe(32);
    expect(
      await commands.get("get_terminal_output_snapshot")?.(
        { sessionId: sessionIds[0] },
        context,
      ),
    ).toEqual({ output: "", revision: 0, generation: 0, truncated: false });
    expect(
      await commands.get("get_terminal_output_snapshot")?.(
        { sessionId: sessionIds.at(-1) },
        context,
      ),
    ).toEqual({
      output: "snapshot-32",
      revision: 1,
      generation: 1,
      truncated: false,
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("caps the terminal output buffer at the maximum size", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-cap-");
    const environment = createEnvironment({
      id: "env-local-terminal-cap",
      environmentType: "local",
      worktreePath,
      containerId: null,
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const maxChars = 500 * 1024;

    const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      { environmentId: environment.id, cols: 80, rows: 24 },
      context,
    )).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);
    await waitForPtyProcessCount(1);

    ptyProcesses[0]?.emitData("A".repeat(maxChars));
    ptyProcesses[0]?.emitData("B".repeat(1024));
    for (let index = 0; index < 2_048; index += 1) {
      ptyProcesses[0]?.emitData("x");
    }
    expect(commandTesting.terminalOutputBufferStats(sessionId)).toMatchObject({
      chars: maxChars,
      sequence: 2_050,
      chunks: expect.any(Number),
    });
    expect(commandTesting.terminalOutputBufferStats(sessionId).chunks)
      .toBeLessThanOrEqual(1_024);
    const buffer = await commands.get("get_terminal_output_buffer")?.({ sessionId }, context) as string;
    expect(buffer.length).toBe(maxChars);
    expect(buffer.endsWith(`${"B".repeat(1024)}${"x".repeat(2_048)}`)).toBe(true);
    expect(buffer.startsWith("A")).toBe(true);
    expect(commands.get("get_terminal_output_snapshot")?.({ sessionId }, context)).toEqual({
      output: buffer,
      revision: 2_050,
      generation: 1,
      truncated: true,
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("does not split a Unicode surrogate pair at the terminal transcript boundary", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-unicode-cap-");
    const environment = createEnvironment({
      id: "env-local-terminal-unicode-cap",
      worktreePath,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const maxChars = 500 * 1024;
    const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      {
        environmentId: environment.id,
        terminalKey: "unicode-tab",
        cols: 80,
        rows: 24,
      },
      context,
    )).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);

    // The nominal cutoff lands between the high and low surrogate. The backend
    // drops the complete astral character rather than returning malformed UTF-16.
    ptyProcesses[0]?.emitData(`😀${"A".repeat(maxChars - 1)}`);
    const snapshot = commands.get("get_terminal_output_snapshot")?.(
      { sessionId },
      context,
    ) as { output: string; truncated: boolean };
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.output).toBe("A".repeat(maxChars - 1));
    expect(snapshot.output).not.toContain("\ufffd");
    expect(Buffer.from(snapshot.output, "utf8").toString("utf8")).toBe(snapshot.output);
  }, ASYNC_TEST_BUDGET_MS);

  test("does not leave a low surrogate when the trimmed pair spans PTY chunks", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-unicode-chunks-");
    const environment = createEnvironment({
      id: "env-local-terminal-unicode-chunks",
      worktreePath,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const maxChars = 500 * 1024;
    const sessionId = terminalSessionResult(
      await commands.get("create_local_terminal_session")?.(
        { environmentId: environment.id, cols: 80, rows: 24 },
        context,
      ),
    ).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);

    // The high and low halves arrive in distinct PTY callbacks. Trimming the
    // oldest code unit therefore drops an entire chunk and must also advance
    // into the next one to remove the orphaned low half.
    ptyProcesses.at(-1)?.emitData("\ud83d");
    ptyProcesses.at(-1)?.emitData(`\ude00${"A".repeat(maxChars - 1)}`);

    const snapshot = commands.get("get_terminal_output_snapshot")?.(
      { sessionId },
      context,
    ) as { output: string; truncated: boolean };
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.output).toBe("A".repeat(maxChars - 1));
    expect(snapshot.output.charCodeAt(0)).not.toBe(0xde00);
    expect(Buffer.from(snapshot.output, "utf8").toString("utf8")).toBe(snapshot.output);
  }, ASYNC_TEST_BUDGET_MS);

  // The renderer calls this *after* setup ran, so a HEAD read here could already
  // include commits made by repository-controlled setup commands. Recording that
  // as the creation commit is worse than recording nothing, because the UI trusts
  // it silently; the backend-managed path is what captures the real baseline.
  test("marks setup complete from the frontend without capturing a post-setup baseline", async () => {
    const environment = createEnvironment({
      id: "env-container-frontend-complete",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  case "$*" in
    *ORKESTRATOR_SETUP_CAPABILITIES*)
      printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
      exit 0
      ;;
    *--prepare-only*)
      printf '\\036ORKESTRATOR_PREPARE_OK\\037'
      exit 0
      ;;
    *rev-parse*)
      printf '2222222222222222222222222222222222222222\\n'
      ;;
  esac
  exit 0
fi
exit 0
`, async (logs) => {
      const updated = await commands.get("set_environment_setup_complete")?.(
        { environmentId: environment.id, complete: true },
        context,
      ) as Environment;

      expect(updated.setupScriptsComplete).toBe(true);
      expect(updated.createdFromCommit).toBeUndefined();
      // No log file at all: the handler never shelled out to the container, so it
      // cannot have run the preparation phase or read a post-setup HEAD.
      expect(existsSync(logs.all)).toBe(false);
    });
  });

  // Fire-and-forget from the renderer (markSetupScriptsComplete only logs on
  // rejection), so failing here would silently re-run setup on every later start.
  test("marks setup complete even when the container is unreachable", async () => {
    const environment = createEnvironment({
      id: "env-container-commit-fail",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "inspect" ]; then
  printf 'exited\\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  printf 'container gone\\n' >&2
  exit 1
fi
exit 0
`, async () => {
      const updated = await commands.get("set_environment_setup_complete")?.(
        { environmentId: environment.id, complete: true },
        context,
      ) as Environment;

      expect(updated.setupScriptsComplete).toBe(true);
      expect(updated.createdFromCommit).toBeUndefined();
      expect(environment.setupScriptsComplete).toBe(true);
    });
  });

  test("clears the setup-complete flag without touching the baseline", async () => {
    const environment = createEnvironment({
      id: "env-container-uncomplete",
      environmentType: "containerized",
      setupScriptsComplete: true,
      createdFromCommit: "3333333333333333333333333333333333333333",
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    const updated = await commands.get("set_environment_setup_complete")?.(
      { environmentId: environment.id, complete: false },
      context,
    ) as Environment;

    expect(updated.setupScriptsComplete).toBe(false);
    expect(updated.createdFromCommit).toBe("3333333333333333333333333333333333333333");
  });

  test("syncs the host gh auth token after starting a newly created container", async () => {
    const environment = createEnvironment({
      id: "env-container-create",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: null,
      status: "stopped",
      branch: "feature/container-create",
      networkAccessMode: "full",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "auth" ] && [ "$2" = "token" ]; then
  printf 'host-gh-token\\n'
  exit 0
fi
exit 1
`, async (ghLog) => {
      await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create) printf 'container-created\\n'; exit 0 ;;
  start) exit 0 ;;
  inspect) printf 'running\\n'; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *github-token*)
        cat > "$FAKE_DOCKER_EXEC_LOG.stdin"
        exit 0
        ;;
      *ORKESTRATOR_SETUP_CAPABILITIES*)
        printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
        exit 0
        ;;
      *--prepare-only*)
        printf '\\036ORKESTRATOR_PREPARE_OK\\037'
        exit 0
        ;;
      *rev-parse*) printf '3333333333333333333333333333333333333333\\n' ;;
    esac
    exit 0
    ;;
esac
exit 0
`, async (logs) => {
        let result: unknown;
        try {
          result = await commands.get("start_environment")?.({ environmentId: environment.id }, context);
        } catch (error) {
          const dockerCalls = await fs.readFile(logs.all, "utf8").catch(() => "");
          const ghCalls = await fs.readFile(ghLog, "utf8").catch(() => "");
          throw new Error(`${error instanceof Error ? error.message : String(error)}\nDocker calls:\n${dockerCalls}\nGH calls:\n${ghCalls}`);
        }
        expect(result).toEqual(expect.objectContaining({
          setupStarted: true,
          setupSessionId: `${environment.id}:setup`,
          environment: expect.objectContaining({
            id: environment.id,
            status: "running",
          }),
        }));
        await waitForPtyProcessCount(1);
        expect(ptySpawn.mock.calls[0]?.[1].at(-1)).toContain("/usr/local/bin/workspace-setup.sh");
        ptyProcesses[0]?.emitData(SETUP_DONE_OSC);

        const ghCalls = await fs.readFile(ghLog, "utf8").catch(() => "");
        expect(ghCalls).toContain("auth token --hostname github.com");

        const dockerCalls = await fs.readFile(logs.all, "utf8");
        expect(dockerCalls).not.toContain("-e GITHUB_TOKEN");
        expect(dockerCalls).not.toContain("-e GH_TOKEN");
        expect(dockerCalls).not.toContain("host-gh-token");
        expect(await fs.readFile(`${logs.exec}.stdin`, "utf8")).toBe("host-gh-token");
        expect(environment.containerId).toBe("container-created");
      });
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("accepts a background container start before Docker creation finishes", async () => {
    const environment = createEnvironment({
      id: "env-container-background",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: null,
      status: "stopped",
      setupScriptsComplete: true,
      pendingAgentLaunch: true,
      networkAccessMode: "full",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const gateDirectory = await createTempDir("ork-background-container-start-");
    const startedPath = path.join(gateDirectory, "started");
    const releasePath = path.join(gateDirectory, "release");
    const shellStartedPath = startedPath.replaceAll("'", "'\\''");
    const shellReleasePath = releasePath.replaceAll("'", "'\\''");

    await withFakeGh(`#!/bin/sh
exit 1
`, async () => {
      await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create)
    : > '${shellStartedPath}'
    while [ ! -f '${shellReleasePath}' ]; do sleep 0.01; done
    printf 'container-background\\n'
    ;;
  start|exec)
    exit 0
    ;;
esac
`, async () => {
        try {
          await expect(
            commands.get("start_environment_background")?.(
              { environmentId: environment.id },
              context,
            ),
          ).resolves.toBeUndefined();

          await waitForCondition(
            () => existsSync(startedPath),
            "background Docker create to begin",
          );
          expect(environment.status).toBe("creating");
          expect(environment.containerId).toBeNull();
          expect(environment.pendingAgentLaunch).toBe(true);
        } finally {
          await fs.writeFile(releasePath, "");
        }

        await waitForCondition(
          () => environment.status === "running",
          "background environment start to finish",
        );
        expect(environment.containerId).toBe("container-background");
        // The start task owns lifecycle only; the renderer clears this after it
        // has durably persisted the requested agent tab.
        expect(environment.pendingAgentLaunch).toBe(true);
      });
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("rejects a background start before admission when the environment is missing or shutdown began", async () => {
    const commands = createCommandRegistry();
    const missing = createContext([]);
    await expect(commands.get("start_environment_background")?.(
      { environmentId: "missing-environment" },
      missing.context,
    )).rejects.toThrow("Environment not found: missing-environment");

    const environment = createEnvironment({
      id: "env-background-shutdown",
      status: "stopped",
      lifecycleError: "Previous failure",
    });
    const { context } = createContext(environment);
    await context.environmentLifecycleTasks.beginShutdown();
    await expect(commands.get("start_environment_background")?.(
      { environmentId: environment.id },
      context,
    )).rejects.toThrow("Backend is shutting down");
    expect(environment.status).toBe("stopped");
    expect(environment.lifecycleError).toBe("Previous failure");
  });

  test("deduplicates concurrent background starts for one environment", async () => {
    const environment = createEnvironment({
      id: "env-background-deduplicated",
      environmentType: "containerized",
      containerId: null,
      status: "stopped",
      setupScriptsComplete: true,
      networkAccessMode: "full",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const gateDirectory = await createTempDir("ork-background-dedupe-");
    const releasePath = path.join(gateDirectory, "release");
    const shellReleasePath = releasePath.replaceAll("'", "'\\''");

    await withFakeGh("#!/bin/sh\nexit 1\n", async () => {
      await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create)
    while [ ! -f '${shellReleasePath}' ]; do sleep 0.01; done
    printf 'container-deduplicated\\n'
    ;;
  start|exec) exit 0 ;;
esac
`, async (logs) => {
        await Promise.all([
          commands.get("start_environment_background")?.({ environmentId: environment.id }, context),
          commands.get("start_environment_background")?.({ environmentId: environment.id }, context),
        ]);
        await fs.writeFile(releasePath, "");
        await waitForCondition(
          () => environment.status === "running",
          "deduplicated background start to finish",
        );
        const calls = await fs.readFile(logs.all, "utf8");
        expect(calls.split("\n").filter((line) => line.startsWith("create "))).toHaveLength(1);
      });
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("persists and logs only a safe background start failure", async () => {
    const secret = "https://user:private-token@example.invalid/private/repo.git";
    const environment = createEnvironment({
      id: "env-background-failure",
      environmentType: "containerized",
      containerId: null,
      status: "stopped",
      lifecycleError: "Old failure",
      setupScriptsComplete: true,
      networkAccessMode: "full",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const errorLog = spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await withFakeDocker(`#!/bin/sh
if [ "$1" = "create" ]; then
  printf '%s\\n' '${secret}' >&2
  exit 1
fi
exit 0
`, async () => {
        await expect(commands.get("start_environment_background")?.(
          { environmentId: environment.id },
          context,
        )).resolves.toBeUndefined();
        await waitForCondition(
          () => environment.status === "error",
          "background failure to persist",
        );
      });
      expect(environment.lifecycleError).toBe(
        "Environment start failed. Check the backend logs and retry.",
      );
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(errorLog.mock.calls)).toContain(environment.lifecycleError);

      await withFakeGh("#!/bin/sh\nexit 1\n", async () => {
        await withFakeDocker(`#!/bin/sh
case "$1" in
  create) printf 'container-after-retry\\n' ;;
  start|exec) exit 0 ;;
esac
`, async () => {
          await expect(commands.get("start_environment")?.(
            { environmentId: environment.id },
            context,
          )).resolves.toEqual(expect.objectContaining({
            environment: expect.objectContaining({
              id: environment.id,
              status: "running",
            }),
          }));
        });
      });
      expect(environment.status).toBe("running");
      expect(environment.lifecycleError).toBeNull();
    } finally {
      errorLog.mockRestore();
    }
  }, ASYNC_TEST_BUDGET_MS);

  test("removes a newly created container when persisting its identity fails", async () => {
    const environment = createEnvironment({
      id: "env-container-persist-compensation",
      environmentType: "containerized",
      containerId: null,
      status: "stopped",
      setupScriptsComplete: true,
      networkAccessMode: "full",
    });
    const { context } = createContext(environment);
    const updateEnvironment = context.storage.updateEnvironment as ReturnType<typeof mock>;
    const originalImplementation = updateEnvironment.getMockImplementation();
    let rejectedContainerIdentity = false;
    updateEnvironment.mockImplementation(async (
      environmentId: string,
      update: Record<string, unknown>,
    ) => {
      if (!rejectedContainerIdentity && update.containerId === "container-unpersisted") {
        rejectedContainerIdentity = true;
        throw new Error("storage unavailable at /private/user/path");
      }
      return originalImplementation!(environmentId, update);
    });
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create) printf 'container-unpersisted\\n' ;;
  rm) exit 0 ;;
esac
`, async (logs) => {
      await expect(commands.get("start_environment")?.(
        { environmentId: environment.id },
        context,
      )).rejects.toThrow("storage unavailable");
      const calls = await fs.readFile(logs.all, "utf8");
      expect(calls).toContain("rm -f container-unpersisted");
      expect(environment.containerId).toBeNull();
      expect(environment.status).toBe("error");
      expect(environment.lifecycleError).not.toContain("/private/user/path");
    });
  });

  test("removes a newly created worktree and its branch when persisting them fails", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    const projectName = "rollback-repo";
    const branch = `worktree-rollback-${randomUUID().slice(0, 8)}`;
    const expectedWorktreePath = expectedManagedWorktreePath(projectName, branch);
    await fs.rm(expectedWorktreePath, { recursive: true, force: true });

    const environment = createEnvironment({
      id: "env-worktree-persist-compensation",
      status: "stopped",
      worktreePath: undefined,
      branch,
      environmentType: "local",
    });
    const { context } = createContext(environment, {
      project: {
        id: environment.projectId,
        name: projectName,
        gitUrl: remote,
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
    });
    const updateEnvironment = context.storage.updateEnvironment as ReturnType<typeof mock>;
    const originalImplementation = updateEnvironment.getMockImplementation();
    updateEnvironment.mockImplementation(async (
      environmentId: string,
      update: Record<string, unknown>,
    ) => {
      // `createLocalWorktree` has already succeeded at this point, so the
      // compensation under test is the one in `startEnvironmentOnce`, not the
      // one inside worktree creation.
      if (update.worktreePath === expectedWorktreePath) {
        throw new Error("storage unavailable at /private/user/path");
      }
      return originalImplementation!(environmentId, update);
    });
    const commands = createCommandRegistry();

    try {
      await expect(commands.get("start_environment")?.(
        { environmentId: environment.id },
        context,
      )).rejects.toThrow("storage unavailable");

      expect(environment.status).toBe("error");
      expect(environment.worktreePath).toBeUndefined();
      expect(environment.lifecycleError).not.toContain("/private/user/path");
      // `git worktree add -b` created a branch as well as a directory. Leaving
      // it behind makes the next start pick `<slug>-1` and drift the branch
      // name further on every retry.
      await expectLocalWorktreeRolledBack(worktree, expectedWorktreePath, branch);
    } finally {
      updateEnvironment.mockImplementation(originalImplementation!);
      await fs.rm(expectedWorktreePath, { recursive: true, force: true });
      await runGit(worktree, ["branch", "-D", branch]).catch(() => undefined);
    }
  }, ASYNC_TEST_BUDGET_MS);

  test("queues a container stop behind background provisioning", async () => {
    const environment = createEnvironment({
      id: "env-background-stop-race",
      environmentType: "containerized",
      containerId: null,
      status: "stopped",
      setupScriptsComplete: true,
      pendingAgentLaunch: true,
      networkAccessMode: "full",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const gateDirectory = await createTempDir("ork-background-stop-race-");
    const startedPath = path.join(gateDirectory, "started");
    const releasePath = path.join(gateDirectory, "release");

    await withFakeGh("#!/bin/sh\nexit 1\n", async () => {
      await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create)
    : > '${startedPath.replaceAll("'", "'\\''")}'
    while [ ! -f '${releasePath.replaceAll("'", "'\\''")}' ]; do sleep 0.01; done
    printf 'container-stop-race\\n'
    ;;
  start|stop|exec) exit 0 ;;
esac
`, async (logs) => {
        await commands.get("start_environment_background")?.(
          { environmentId: environment.id },
          context,
        );
        await waitForCondition(() => existsSync(startedPath), "container create to begin");
        const stop = commands.get("stop_environment")?.(
          { environmentId: environment.id },
          context,
        );
        await fs.writeFile(releasePath, "");
        await expect(stop).resolves.toBeUndefined();
        expect(environment.status).toBe("stopped");
        expect(environment.pendingAgentLaunch).toBe(false);
        const calls = await fs.readFile(logs.all, "utf8");
        expect(calls.indexOf("start container-stop-race")).toBeLessThan(
          calls.indexOf("stop container-stop-race"),
        );
      });
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("queues container deletion behind provisioning and removes the created resource", async () => {
    const environment = createEnvironment({
      id: "env-background-delete-race",
      environmentType: "containerized",
      containerId: null,
      status: "stopped",
      setupScriptsComplete: true,
      networkAccessMode: "full",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const gateDirectory = await createTempDir("ork-background-delete-race-");
    const startedPath = path.join(gateDirectory, "started");
    const releasePath = path.join(gateDirectory, "release");

    await withFakeGh("#!/bin/sh\nexit 1\n", async () => {
      await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create)
    : > '${startedPath.replaceAll("'", "'\\''")}'
    while [ ! -f '${releasePath.replaceAll("'", "'\\''")}' ]; do sleep 0.01; done
    printf 'container-delete-race\\n'
    ;;
  start|exec|rm) exit 0 ;;
esac
`, async (logs) => {
        await commands.get("start_environment_background")?.(
          { environmentId: environment.id },
          context,
        );
        await waitForCondition(() => existsSync(startedPath), "container create to begin");
        const deletion = commands.get("delete_environment")?.(
          { environmentId: environment.id },
          context,
        );
        await fs.writeFile(releasePath, "");
        await expect(deletion).resolves.toBeUndefined();
        await expect(context.storage.getEnvironment(environment.id)).resolves.toBeNull();
        const calls = await fs.readFile(logs.all, "utf8");
        expect(calls).toContain("rm -f container-delete-race");
      });
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("queues a local stop behind a background start", async () => {
    const worktreePath = await createGitRepoOnBranch("feature-local-start-stop");
    const environment = createEnvironment({
      id: "env-local-background-stop-race",
      environmentType: "local",
      worktreePath,
      branch: "feature-local-start-stop",
      status: "stopped",
      setupScriptsComplete: true,
      pendingAgentLaunch: true,
    });
    const { context } = createContext(environment);
    const updateEnvironment = context.storage.updateEnvironment as ReturnType<typeof mock>;
    const originalImplementation = updateEnvironment.getMockImplementation();
    let announceCreating!: () => void;
    let releaseCreating!: () => void;
    const creatingStarted = new Promise<void>((resolve) => {
      announceCreating = resolve;
    });
    const creatingRelease = new Promise<void>((resolve) => {
      releaseCreating = resolve;
    });
    updateEnvironment.mockImplementation(async (
      environmentId: string,
      update: Record<string, unknown>,
    ) => {
      if (update.status === "creating") {
        announceCreating();
        await creatingRelease;
      }
      return originalImplementation!(environmentId, update);
    });
    const commands = createCommandRegistry();

    await commands.get("start_environment_background")?.(
      { environmentId: environment.id },
      context,
    );
    await creatingStarted;
    const stop = commands.get("stop_environment")?.(
      { environmentId: environment.id },
      context,
    );
    releaseCreating();
    await expect(stop).resolves.toBeUndefined();
    expect(environment.status).toBe("stopped");
    expect(environment.pendingAgentLaunch).toBe(false);
  }, ASYNC_TEST_BUDGET_MS);

  test("queues stop behind container recreation without orphaning the replacement", async () => {
    const environment = createEnvironment({
      id: "env-recreate-stop-race",
      environmentType: "containerized",
      containerId: "container-old",
      status: "running",
      setupScriptsComplete: true,
      networkAccessMode: "full",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const gateDirectory = await createTempDir("ork-recreate-stop-race-");
    const startedPath = path.join(gateDirectory, "started");
    const releasePath = path.join(gateDirectory, "release");

    await withFakeGh("#!/bin/sh\nexit 1\n", async () => {
      await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1:$2" in
  rm:-f)
    : > '${startedPath.replaceAll("'", "'\\''")}'
    while [ ! -f '${releasePath.replaceAll("'", "'\\''")}' ]; do sleep 0.01; done
    ;;
esac
case "$1" in
  create) printf 'container-replacement\\n' ;;
  start|stop|exec|rm) exit 0 ;;
esac
`, async (logs) => {
        const recreate = commands.get("recreate_environment")?.(
          { environmentId: environment.id },
          context,
        );
        await waitForCondition(() => existsSync(startedPath), "container removal to begin");
        const stop = commands.get("stop_environment")?.(
          { environmentId: environment.id },
          context,
        );
        await fs.writeFile(releasePath, "");
        await expect(recreate).resolves.toEqual(expect.objectContaining({
          environment: expect.objectContaining({
            id: environment.id,
            containerId: "container-replacement",
          }),
        }));
        await expect(stop).resolves.toBeUndefined();
        expect(environment.containerId).toBe("container-replacement");
        expect(environment.status).toBe("stopped");
        const calls = await fs.readFile(logs.all, "utf8");
        expect(calls).toContain("rm -f container-old");
        expect(calls).toContain("stop container-replacement");
      });
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("classifies each lifecycle failure category from its structured outcome", () => {
    const classify = commandTesting.environmentLifecycleErrorMessage;

    // `execFile` SIGTERMs a timed-out child, so stdout/stderr are empty and the
    // message is the generic "Command failed: <argv>". The outcome flag is the
    // only place the timeout is visible.
    expect(classify(new CommandFailedError("Command failed: docker start abc", {
      timedOut: true,
    }))).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.timedOut);
    expect(classify(new CommandFailedError("spawn docker ENOENT", {
      executableMissing: true,
    }))).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.runtimeUnavailable);

    // Real Docker CLI strings, not paraphrases of them.
    expect(classify(new Error(
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    ))).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.runtimeUnavailable);
    expect(classify(new Error(
      "Unable to find image 'orkestrator-v2:latest' locally\ndocker: Error response from daemon: pull access denied",
    ))).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.imageUnavailable);
    expect(classify(new Error(
      "docker: Error response from daemon: manifest unknown",
    ))).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.imageUnavailable);
    expect(classify(new Error(
      "failed to register layer: write /var/lib/docker/x: no space left on device",
    ))).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.diskFull);

    expect(classify(new Error("Project has no local path - cannot create a local worktree")))
      .toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.noLocalPath);
    expect(classify(new Error("Setup script failed")))
      .toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.setupScript);

    // Anything unrecognized collapses to the fallback rather than leaking the
    // child's own text into a persisted, rendered field.
    expect(classify(new Error("fatal: could not read Username for 'https://github.com'")))
      .toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.unknown);
    expect(classify("a bare string")).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.unknown);
    expect(classify(undefined)).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.unknown);

    // Every reachable value is one of the fixed constants.
    expect(Object.values(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES))
      .toContain(classify(new Error("anything at all")));
  });

  test("scrubs credentials a child echoed but the caller never named", () => {
    const scrub = commandTesting.scrubLifecycleLogDetail;

    expect(scrub("fatal: could not read from https://user:private-token@example.invalid/repo.git"))
      .toBe("fatal: could not read from https://[redacted]@example.invalid/repo.git");
    expect(scrub("remote: Authorization: Bearer abc123.def-456"))
      .toBe("remote: Authorization: Bearer [redacted]");
    expect(scrub("token ghp_abcdefghijklmnop rejected")).toBe("token [redacted] rejected");
    expect(scrub("token github_pat_11ABCDEFG0abcdefg rejected")).toBe("token [redacted] rejected");
    expect(scrub("key sk-ant-api03-abcdefghijklmnop rejected")).toBe("key [redacted] rejected");

    // Bounded, so one pathological child cannot flood the log.
    expect(scrub("x".repeat(2_000))).toHaveLength(501);
    // Ordinary diagnostics survive intact — the point is to keep them readable.
    expect(scrub("Cannot connect to the Docker daemon at unix:///var/run/docker.sock"))
      .toBe("Cannot connect to the Docker daemon at unix:///var/run/docker.sock");
  });

  test("refuses every foreground lifecycle command once shutdown has begun", async () => {
    const environment = createEnvironment({
      id: "env-foreground-shutdown",
      environmentType: "containerized",
      containerId: "container-shutdown",
      status: "running",
      lifecycleError: "Previous failure",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    await context.environmentLifecycleTasks.beginShutdown();

    for (const command of [
      "start_environment",
      "stop_environment",
      "recreate_environment",
      "delete_environment",
    ]) {
      await expect(commands.get(command)?.(
        { environmentId: environment.id },
        context,
      )).rejects.toThrow("Backend is shutting down");
    }

    // Refusal is total: nothing was mutated on the way out.
    expect(environment.status).toBe("running");
    expect(environment.containerId).toBe("container-shutdown");
    expect(environment.lifecycleError).toBe("Previous failure");
    // A refused delete must not keep the tombstone that blocks local-server
    // starts and merges for this environment.
    expect(commandTesting.isEnvironmentDeleting(environment.id)).toBe(false);
  });

  test("refuses to delete a merging environment without reserving the tombstone", async () => {
    const environment = createEnvironment({
      id: "env-delete-while-merging",
      environmentType: "local",
      containerId: null,
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    commandTesting.markEnvironmentMerging(environment.id);

    await expect(commands.get("delete_environment")?.(
      { environmentId: environment.id },
      context,
    )).rejects.toThrow("Environment is currently being merged");
    // Reserving before the refusal would block local-server starts and further
    // merges for an environment that is not being deleted at all.
    expect(commandTesting.isEnvironmentDeleting(environment.id)).toBe(false);
  });

  test("rejects starts while deletion is reserved before cleanup settles", async () => {
    const worktreePath = await createTempDir("ork-start-while-delete-reserved-");
    const environment = createEnvironment({
      id: "env-start-while-delete-reserved",
      environmentType: "local",
      containerId: null,
      worktreePath,
      status: "running",
      setupScriptsComplete: true,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    let announceTermination!: () => void;
    let releaseTermination!: (terminated: boolean) => void;
    const terminationStarted = new Promise<void>((resolve) => {
      announceTermination = resolve;
    });
    const terminationResult = new Promise<boolean>((resolve) => {
      releaseTermination = resolve;
    });
    commandTesting.setLocalServerProcess(
      `codex:${environment.id}`,
      createFakeChild(95050),
    );
    commandTesting.setTerminateProcessTree(async () => {
      announceTermination();
      return terminationResult;
    });

    const deletion = commands.get("delete_environment")?.(
      { environmentId: environment.id },
      context,
    );
    await terminationStarted;
    expect(commandTesting.isEnvironmentDeleting(environment.id)).toBe(true);

    await expect(commands.get("start_environment")?.(
      { environmentId: environment.id },
      context,
    )).rejects.toThrow(`Environment is being deleted: ${environment.id}`);
    await expect(commands.get("start_environment_background")?.(
      { environmentId: environment.id },
      context,
    )).rejects.toThrow(`Environment is being deleted: ${environment.id}`);

    releaseTermination(false);
    await expect(deletion).rejects.toThrow("Failed to stop all local servers");
    commandTesting.setTerminateProcessTree(async () => true);
  });

  test("rejects starts carrying a durable deletion tombstone", async () => {
    const environment = createEnvironment({
      id: "env-start-with-delete-tombstone",
      environmentType: "containerized",
      containerId: "container-delete-tombstone",
      status: "stopped",
      setupScriptsComplete: true,
      deletionRequestedAt: "2026-07-29T10:00:00.000Z",
    });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();

    await expect(commands.get("start_environment")?.(
      { environmentId: environment.id },
      context,
    )).rejects.toThrow(`Environment is being deleted: ${environment.id}`);
    await expect(commands.get("start_environment_background")?.(
      { environmentId: environment.id },
      context,
    )).rejects.toThrow(`Environment is being deleted: ${environment.id}`);
    expect(updates).toHaveLength(0);
  });

  test("rechecks a durable deletion tombstone when a queued start executes", async () => {
    const environment = createEnvironment({
      id: "env-queued-start-delete-tombstone",
      environmentType: "containerized",
      containerId: "container-queued-delete-tombstone",
      status: "running",
      setupScriptsComplete: true,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const gateDirectory = await createTempDir("ork-queued-start-delete-tombstone-");
    const stopStartedPath = path.join(gateDirectory, "stop-started");
    const releaseStopPath = path.join(gateDirectory, "release-stop");
    const errorLog = spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "stop" ]; then
  : > '${stopStartedPath.replaceAll("'", "'\\''")}'
  while [ ! -f '${releaseStopPath.replaceAll("'", "'\\''")}' ]; do sleep 0.01; done
  exit 0
fi
exit 0
`, async ({ all }) => {
        const stop = commands.get("stop_environment")?.(
          { environmentId: environment.id },
          context,
        );
        await waitForCondition(() => existsSync(stopStartedPath), "container stop to begin");
        await commands.get("start_environment_background")?.(
          { environmentId: environment.id },
          context,
        );

        // This represents deletion intent persisted while the accepted start
        // was waiting behind an earlier lifecycle operation.
        environment.deletionRequestedAt = "2026-07-29T11:00:00.000Z";
        await fs.writeFile(releaseStopPath, "");
        await expect(stop).resolves.toBeUndefined();
        await waitForCondition(
          () => errorLog.mock.calls.some(([message]) =>
            String(message).includes("background start failed")
          ),
          "queued start rejection",
        );

        const calls = await fs.readFile(all, "utf8");
        expect(calls.split("\n").filter((line) => line.startsWith("start "))).toHaveLength(0);
        expect(environment.status).toBe("stopped");
        expect(environment.deletionRequestedAt).toBe(
          "2026-07-29T11:00:00.000Z",
        );
      });
    } finally {
      errorLog.mockRestore();
    }
  }, ASYNC_TEST_BUDGET_MS);

  test("refuses deletion while local servers are shutting down", async () => {
    const environment = createEnvironment({
      id: "env-delete-during-shutdown",
      environmentType: "local",
      containerId: null,
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    closeLocalServerAdmission();

    await expect(commands.get("delete_environment")?.(
      { environmentId: environment.id },
      context,
    )).rejects.toThrow("Backend is shutting down");
    expect(commandTesting.isEnvironmentDeleting(environment.id)).toBe(false);
  });

  test("deduplicates concurrent foreground starts for one environment", async () => {
    const environment = createEnvironment({
      id: "env-foreground-deduplicated",
      environmentType: "containerized",
      containerId: null,
      status: "stopped",
      setupScriptsComplete: true,
      networkAccessMode: "full",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const gateDirectory = await createTempDir("ork-foreground-dedupe-");
    const releasePath = path.join(gateDirectory, "release");

    await withFakeGh("#!/bin/sh\nexit 1\n", async () => {
      await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create)
    while [ ! -f '${releasePath.replaceAll("'", "'\\''")}' ]; do sleep 0.01; done
    printf 'container-foreground-dedupe\\n'
    ;;
  start|exec) exit 0 ;;
esac
`, async (logs) => {
        const first = commands.get("start_environment")?.({ environmentId: environment.id }, context);
        const second = commands.get("start_environment")?.({ environmentId: environment.id }, context);
        await fs.writeFile(releasePath, "");
        await Promise.all([first, second]);

        const calls = await fs.readFile(logs.all, "utf8");
        expect(calls.split("\n").filter((line) => line.startsWith("create "))).toHaveLength(1);
      });
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("clears a stale failure only once the stop has actually committed", async () => {
    const environment = createEnvironment({
      id: "env-stop-clears-failure",
      environmentType: "containerized",
      containerId: "container-stop-failure",
      status: "error",
      lifecycleError: "The container runtime is unavailable. Start it and retry.",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "stop" ]; then
  printf 'container runtime refused stop\\n' >&2
  exit 1
fi
exit 0
`, async () => {
      await expect(commands.get("stop_environment")?.(
        { environmentId: environment.id },
        context,
      )).rejects.toThrow("container runtime refused stop");
    });
    // Clearing ahead of the stop would have erased the only explanation the
    // user has, leaving an environment in `error` with nothing to show.
    expect(environment.status).toBe("error");
    expect(environment.lifecycleError).toBe(
      "The container runtime is unavailable. Start it and retry.",
    );

    await withFakeDocker("#!/bin/sh\nexit 0\n", async () => {
      await expect(commands.get("stop_environment")?.(
        { environmentId: environment.id },
        context,
      )).resolves.toBeUndefined();
    });
    expect(environment.status).toBe("stopped");
    expect(environment.lifecycleError).toBeNull();
  });

  test("keeps a local stop failure's explanation while still recording the stop", async () => {
    const worktreePath = await createTempDir("ork-electron-stop-local-keeps-error-");
    const environment = createEnvironment({
      id: "env-stop-local-keeps-error",
      environmentType: "local",
      containerId: null,
      worktreePath,
      status: "error",
      lifecycleError: "Environment start failed. Check the backend logs and retry.",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    commandTesting.setLocalServerProcess(`codex:${environment.id}`, createFakeChild(95010));
    commandTesting.setTerminateProcessTree(async () => false);

    await expect(commands.get("stop_environment")?.(
      { environmentId: environment.id },
      context,
    )).rejects.toThrow("Failed to stop all local servers");

    // Partial progress is recorded so the environment is not stranded, but the
    // failure it was already carrying is not silently erased by a stop that
    // itself failed.
    expect(environment.status).toBe("stopped");
    expect(environment.lifecycleError).toBe(
      "Environment start failed. Check the backend logs and retry.",
    );

    commandTesting.setTerminateProcessTree(async () => true);
  });

  test("queues a recreate behind an in-flight start instead of interleaving it", async () => {
    const environment = createEnvironment({
      id: "env-start-recreate-race",
      environmentType: "containerized",
      containerId: null,
      status: "stopped",
      setupScriptsComplete: true,
      networkAccessMode: "full",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const gateDirectory = await createTempDir("ork-start-recreate-race-");
    const startedPath = path.join(gateDirectory, "started");
    const releasePath = path.join(gateDirectory, "release");

    await withFakeGh("#!/bin/sh\nexit 1\n", async () => {
      await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create)
    if [ ! -f '${startedPath.replaceAll("'", "'\\''")}' ]; then
      : > '${startedPath.replaceAll("'", "'\\''")}'
      while [ ! -f '${releasePath.replaceAll("'", "'\\''")}' ]; do sleep 0.01; done
      printf 'container-first\\n'
    else
      printf 'container-recreated\\n'
    fi
    ;;
  start|stop|exec|rm) exit 0 ;;
esac
`, async (logs) => {
        await commands.get("start_environment_background")?.(
          { environmentId: environment.id },
          context,
        );
        await waitForCondition(() => existsSync(startedPath), "first container create to begin");
        const recreate = commands.get("recreate_environment")?.(
          { environmentId: environment.id },
          context,
        );
        await fs.writeFile(releasePath, "");
        await expect(recreate).resolves.toEqual(expect.objectContaining({
          environment: expect.objectContaining({
            id: environment.id,
            containerId: "container-recreated",
            status: "running",
          }),
        }));

        expect(environment.containerId).toBe("container-recreated");
        expect(environment.status).toBe("running");
        const calls = await fs.readFile(logs.all, "utf8");
        // The recreate observed the container the start had produced, which is
        // only possible if it ran after that start committed rather than
        // alongside it.
        expect(calls.indexOf("start container-first")).toBeLessThan(
          calls.indexOf("rm -f container-first"),
        );
      });
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("a start requested after a stop does not join the start the stop will undo", async () => {
    const environment = createEnvironment({
      id: "env-start-dedupe-invalidated",
      environmentType: "containerized",
      containerId: null,
      status: "stopped",
      setupScriptsComplete: true,
      networkAccessMode: "full",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const gateDirectory = await createTempDir("ork-start-dedupe-invalidated-");
    const startedPath = path.join(gateDirectory, "started");
    const releasePath = path.join(gateDirectory, "release");

    await withFakeGh("#!/bin/sh\nexit 1\n", async () => {
      await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create)
    : > '${startedPath.replaceAll("'", "'\\''")}'
    while [ ! -f '${releasePath.replaceAll("'", "'\\''")}' ]; do sleep 0.01; done
    printf 'container-dedupe\\n'
    ;;
  start|stop|exec) exit 0 ;;
esac
`, async () => {
        await commands.get("start_environment_background")?.(
          { environmentId: environment.id },
          context,
        );
        await waitForCondition(() => existsSync(startedPath), "container create to begin");

        const stop = commands.get("stop_environment")?.(
          { environmentId: environment.id },
          context,
        );
        // Joining the in-flight start here would resolve as soon as that start
        // finished — before the stop that is already queued ahead of it — and
        // report a running environment the user had asked to be stopped.
        const restart = commands.get("start_environment")?.(
          { environmentId: environment.id },
          context,
        );
        await fs.writeFile(releasePath, "");

        await expect(stop).resolves.toBeUndefined();
        await expect(restart).resolves.toEqual(expect.objectContaining({
          environment: expect.objectContaining({
            id: environment.id,
            status: "running",
          }),
        }));
        expect(environment.status).toBe("running");
      });
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("runs work queued behind a lifecycle operation that rejected", async () => {
    const environment = createEnvironment({
      id: "env-queue-not-poisoned",
      environmentType: "containerized",
      containerId: null,
      status: "stopped",
      setupScriptsComplete: true,
      networkAccessMode: "full",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const gateDirectory = await createTempDir("ork-queue-not-poisoned-");
    const startedPath = path.join(gateDirectory, "started");
    const releasePath = path.join(gateDirectory, "release");
    const errorLog = spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await withFakeGh("#!/bin/sh\nexit 1\n", async () => {
        await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create)
    : > '${startedPath.replaceAll("'", "'\\''")}'
    while [ ! -f '${releasePath.replaceAll("'", "'\\''")}' ]; do sleep 0.01; done
    printf 'provisioning refused\\n' >&2
    exit 1
    ;;
  start|stop|exec) exit 0 ;;
esac
`, async () => {
          await commands.get("start_environment_background")?.(
            { environmentId: environment.id },
            context,
          );
          await waitForCondition(() => existsSync(startedPath), "container create to begin");
          // Queued while the predecessor is still running, so it can only run
          // through the rejected tail.
          const stop = commands.get("stop_environment")?.(
            { environmentId: environment.id },
            context,
          );
          await fs.writeFile(releasePath, "");

          await expect(stop).resolves.toBeUndefined();
          expect(environment.status).toBe("stopped");
        });
      });
    } finally {
      errorLog.mockRestore();
    }
  }, ASYNC_TEST_BUDGET_MS);

  test("recreates a container even when the old one cannot be removed", async () => {
    const environment = createEnvironment({
      id: "env-recreate-remove-failure",
      environmentType: "containerized",
      containerId: "container-still-present",
      status: "running",
      setupScriptsComplete: true,
      networkAccessMode: "full",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const errorLog = spyOn(console, "error").mockImplementation(() => undefined);

    try {
      // Recreate is the repair action for an already-broken container, so a
      // daemon that refuses the removal must not be what makes the environment
      // permanently unrepairable from the UI.
      await withFakeGh("#!/bin/sh\nexit 1\n", async () => {
        await withFakeDocker(`#!/bin/sh
case "$1" in
  rm)
    printf 'container runtime refused removal\\n' >&2
    exit 1
    ;;
  create) printf 'container-after-recreate\\n' ;;
  start|exec) exit 0 ;;
esac
`, async () => {
          await expect(commands.get("recreate_environment")?.(
            { environmentId: environment.id },
            context,
          )).resolves.toEqual(expect.objectContaining({
            environment: expect.objectContaining({
              id: environment.id,
              containerId: "container-after-recreate",
              status: "running",
            }),
          }));
        });
      });

      expect(environment.containerId).toBe("container-after-recreate");
      expect(environment.status).toBe("running");
      expect(environment.lifecycleError).toBeNull();
      // The daemon-level cause is still recoverable from the backend logs.
      expect(JSON.stringify(errorLog.mock.calls)).toContain("container runtime refused removal");
    } finally {
      errorLog.mockRestore();
    }
  }, ASYNC_TEST_BUDGET_MS);

  test("reports whether the selected host GitHub CLI credential is available", async () => {
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();

    await withFakeGh(`#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "token" ]; then
  printf 'host-gh-token\\n'
  exit 0
fi
exit 1
`, async () => {
      await expect(
        commands.get("get_container_github_credential_status")?.({}, context),
      ).resolves.toEqual({
        source: "host-cli",
        available: true,
      });
    });

    await withFakeGh(`#!/bin/sh
exit 1
`, async () => {
      await expect(
        commands.get("get_container_github_credential_status")?.({}, context),
      ).resolves.toEqual({
        source: "host-cli",
        available: false,
      });
    });
  });

  test("reports missing PAT credentials without reading host GitHub CLI auth", async () => {
    const { context } = createContext(createEnvironment(), {
      globalConfig: { useHostGitHubCredentials: false },
    });
    const commands = createCommandRegistry();

    await withFakeGh(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
exit 0
`, async (ghLog) => {
      await expect(
        commands.get("get_container_github_credential_status")?.({}, context),
      ).resolves.toEqual({
        source: "pat",
        available: false,
      });
      expect(await fs.readFile(ghLog, "utf8").catch(() => "")).toBe("");
    });

    const configuredContext = createContext(createEnvironment(), {
      globalConfig: {
        useHostGitHubCredentials: false,
        githubToken: "configured-pat",
      },
    }).context;
    await expect(
      commands.get("get_container_github_credential_status")?.({}, configuredContext),
    ).resolves.toEqual({
      source: "pat",
      available: true,
    });
  });

  test("does not persist the configured PAT in new container metadata", async () => {
    const environment = createEnvironment({
      id: "env-container-pat",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: null,
      status: "stopped",
      networkAccessMode: "full",
    });
    const { context } = createContext(environment, {
      globalConfig: {
        useHostGitHubCredentials: false,
        githubToken: "configured-pat",
      },
    });
    const commands = createCommandRegistry();

    await withFakeGh(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
exit 1
`, async (ghLog) => {
      await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "create" ]; then
  printf 'container-created\\n'
  exit 0
fi
exit 0
`, async (logs) => {
        await expect(commands.get("provision_environment")?.(
          { environmentId: environment.id },
          context,
        )).resolves.toBe("container-created");

        expect(await fs.readFile(ghLog, "utf8").catch(() => "")).toBe("");
        const dockerCalls = await fs.readFile(logs.all, "utf8");
        expect(dockerCalls).not.toContain("-e GITHUB_TOKEN");
        expect(dockerCalls).not.toContain("-e GH_TOKEN");
        expect(dockerCalls).not.toContain("configured-pat");
      });
    });
  });

  test("does not expose configured credentials in Docker argv or container creation errors", async () => {
    const githubToken = "github_secret_token";
    const anthropicApiKey = "anthropic_secret_key";
    const environment = createEnvironment({
      id: "env-container-secret-failure",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: null,
      status: "stopped",
      networkAccessMode: "full",
    });
    const { context } = createContext(environment);
    Object.assign(context.storage, {
      loadConfig: mock(async () => ({
        version: "1.0.0",
        global: { useHostGitHubCredentials: false, githubToken, anthropicApiKey },
        repositories: {
          "project-1": { defaultBranch: "main", prBaseBranch: "main" },
        },
      })),
    });
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "create" ]; then
  printf 'Docker permission denied for %s and %s\\n' "$GITHUB_TOKEN" "$ANTHROPIC_API_KEY" >&2
  exit 42
fi
exit 0
`, async (logs) => {
      let failure: unknown;
      try {
        await commands.get("provision_environment")?.({ environmentId: environment.id }, context);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("Docker permission denied");
      expect((failure as Error).message).toContain("[REDACTED]");
      expect((failure as Error).message).not.toContain(githubToken);
      expect((failure as Error).message).not.toContain(anthropicApiKey);

      const dockerCalls = await fs.readFile(logs.all, "utf8");
      expect(dockerCalls).not.toContain("-e GITHUB_TOKEN");
      expect(dockerCalls).not.toContain("-e GH_TOKEN");
      expect(dockerCalls).toContain("-e ANTHROPIC_API_KEY");
      expect(dockerCalls).not.toContain(githubToken);
      expect(dockerCalls).not.toContain(anthropicApiKey);
    });
  });

  test("stages configured gitignored files into new container environments", async () => {
    const projectPath = await createTempDir("ork-electron-container-copy-source-");
    await runGit(projectPath, ["init"]);
    await runGit(projectPath, ["checkout", "-b", "main"]);
    await fs.writeFile(path.join(projectPath, ".gitignore"), "environments.json\nnested/secret.json\n");
    await runGit(projectPath, ["add", ".gitignore"]);
    await runGit(projectPath, ["commit", "-m", "ignore copied files"]);
    await fs.mkdir(path.join(projectPath, "nested"), { recursive: true });
    await fs.writeFile(path.join(projectPath, "environments.json"), "{\"copied\":true}\n");
    await fs.writeFile(path.join(projectPath, "nested", "secret.json"), "{\"nested\":true}\n");
    await runGit(projectPath, ["check-ignore", "environments.json"]);

    const environment = createEnvironment({
      id: "env-container-copy",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: null,
      status: "stopped",
      networkAccessMode: "full",
    });
    const { context } = createContext(environment, {
      project: {
        id: environment.projectId,
        name: "Copy Source",
        gitUrl: "https://github.com/acme/copy-source.git",
        localPath: projectPath,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
      repositoryConfig: {
        defaultBranch: "main",
        prBaseBranch: "main",
        filesToCopy: ["environments.json", "nested/secret.json"],
      },
    });
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create)
    printf 'container-copy-created\\n'
    exit 0
    ;;
  cp)
    src="$2"
    cat "$src/environments.json" > "$FAKE_DOCKER_LOG.container-copy-root"
    cat "$src/nested/secret.json" > "$FAKE_DOCKER_LOG.container-copy-nested"
    printf '%s\\n' "$3" > "$FAKE_DOCKER_LOG.container-copy-dest"
    exit 0
    ;;
  start)
    exit 0
    ;;
  inspect)
    printf 'running\\n'
    exit 0
    ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *ORKESTRATOR_SETUP_CAPABILITIES*)
        printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
        exit 0
        ;;
      *--prepare-only*)
        printf '\\036ORKESTRATOR_PREPARE_OK\\037'
        exit 0
        ;;
      *rev-parse*) printf '4444444444444444444444444444444444444444\\n' ;;
    esac
    exit 0
    ;;
esac
exit 0
`, async (logs) => {
      let result: unknown;
      try {
        result = await commands.get("start_environment")?.({ environmentId: environment.id }, context);
      } catch (error) {
        const dockerCalls = await fs.readFile(logs.all, "utf8").catch(() => "");
        const copiedRoot = await fs.readFile(`${logs.all}.container-copy-root`, "utf8").catch(() => "");
        throw new Error(`${error instanceof Error ? error.message : String(error)}\nDocker calls:\n${dockerCalls}\nCopied root:\n${copiedRoot}`);
      }
      expect(result).toEqual(expect.objectContaining({
        setupStarted: true,
        setupSessionId: `${environment.id}:setup`,
        environment: expect.objectContaining({
          id: environment.id,
          containerId: "container-copy-created",
          status: "running",
        }),
      }));
      await waitForPtyProcessCount(1);
      ptyProcesses[0]?.emitData(SETUP_DONE_OSC);

      await expect(fs.readFile(`${logs.all}.container-copy-root`, "utf8")).resolves.toBe("{\"copied\":true}\n");
      await expect(fs.readFile(`${logs.all}.container-copy-nested`, "utf8")).resolves.toBe("{\"nested\":true}\n");
      await expect(fs.readFile(`${logs.all}.container-copy-dest`, "utf8")).resolves.toBe("container-copy-created:/project-files\n");
      expect(environment.containerId).toBe("container-copy-created");
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("removes a newly created container when configured file docker copy fails", async () => {
    const projectPath = await createTempDir("ork-electron-container-copy-fail-source-");
    await fs.writeFile(path.join(projectPath, "settings.json"), "{\"copied\":true}\n");

    const environment = createEnvironment({
      id: "env-container-copy-fail",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: null,
      status: "stopped",
      networkAccessMode: "full",
    });
    const { context } = createContext(environment, {
      project: {
        id: environment.projectId,
        name: "Copy Failure",
        gitUrl: "https://github.com/acme/copy-failure.git",
        localPath: projectPath,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
      repositoryConfig: {
        defaultBranch: "main",
        prBaseBranch: "main",
        filesToCopy: ["settings.json"],
      },
    });
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create)
    printf 'container-copy-fail\\n'
    exit 0
    ;;
  cp)
    exit 42
    ;;
  rm)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_RM_LOG"
    exit 0
    ;;
esac
exit 0
`, async (logs) => {
      await expect(commands.get("start_environment")?.({ environmentId: environment.id }, context)).rejects.toThrow();

      const dockerCalls = (await fs.readFile(logs.all, "utf8")).split("\n").filter(Boolean);
      expect(dockerCalls.some((line) => line.startsWith("create "))).toBe(true);
      expect(dockerCalls.some((line) => line.startsWith("cp "))).toBe(true);
      expect(dockerCalls.some((line) => line.startsWith("start "))).toBe(false);
      await expect(fs.readFile(logs.rm, "utf8")).resolves.toBe("rm -f container-copy-fail\n");
      expect(environment.status).toBe("error");
      expect(environment.containerId).toBeNull();
    });
  });

  test("rejects configured container file symlinks that escape the project and removes the container", async () => {
    const projectPath = await createTempDir("ork-electron-container-copy-symlink-source-");
    const outsidePath = path.join(await createTempDir("ork-electron-container-copy-outside-"), "secret.json");
    await fs.writeFile(outsidePath, "{\"outside\":true}\n");
    await fs.symlink(outsidePath, path.join(projectPath, "secret-link.json"));

    const environment = createEnvironment({
      id: "env-container-copy-symlink",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: null,
      status: "stopped",
      networkAccessMode: "full",
    });
    const { context } = createContext(environment, {
      project: {
        id: environment.projectId,
        name: "Copy Symlink",
        gitUrl: "https://github.com/acme/copy-symlink.git",
        localPath: projectPath,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
      repositoryConfig: {
        defaultBranch: "main",
        prBaseBranch: "main",
        filesToCopy: ["secret-link.json"],
      },
    });
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create)
    printf 'container-symlink-fail\\n'
    exit 0
    ;;
  rm)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_RM_LOG"
    exit 0
    ;;
esac
exit 0
`, async (logs) => {
      await expect(commands.get("start_environment")?.({ environmentId: environment.id }, context)).rejects.toThrow(
        "Configured file to copy must stay inside the project: secret-link.json",
      );

      const dockerCalls = (await fs.readFile(logs.all, "utf8")).split("\n").filter(Boolean);
      expect(dockerCalls.some((line) => line.startsWith("create "))).toBe(true);
      expect(dockerCalls.some((line) => line.startsWith("cp "))).toBe(false);
      expect(dockerCalls.some((line) => line.startsWith("start "))).toBe(false);
      await expect(fs.readFile(logs.rm, "utf8")).resolves.toBe("rm -f container-symlink-fail\n");
      expect(environment.status).toBe("error");
      expect(environment.containerId).toBeNull();
    });
  });

  test("creates local worktrees from the fetched remote base branch", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    const updater = await createTempDir("ork-electron-remote-updater-");
    await runGit(updater, ["clone", remote, "."]);
    await runGit(updater, ["checkout", "main"]);
    await fs.writeFile(path.join(updater, "tracked.txt"), "remote\n");
    await runGit(updater, ["add", "tracked.txt"]);
    await runGit(updater, ["commit", "-m", "remote update"]);
    await runGit(updater, ["push", "origin", "main"]);

    const environment = createEnvironment({
      status: "stopped",
      worktreePath: undefined,
      branch: "feature/remote-base",
      environmentType: "local",
    });
    const projectName = `Remote Base ${randomUUID().slice(0, 8)}`;
    const { context } = createContext(environment, {
      project: {
        id: environment.projectId,
        name: projectName,
        gitUrl: remote,
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
      repositoryConfig: { defaultBranch: "main", prBaseBranch: "main" },
    });
    const commands = createCommandRegistry();

    try {
      await expect(commands.get("start_environment")?.({ environmentId: environment.id }, context)).resolves.toEqual(expect.objectContaining({
        setupStarted: false,
        environment: expect.objectContaining({
          id: environment.id,
          status: "running",
        }),
      }));

      expect(environment.worktreePath).toBeDefined();
      expect(environment.branch).toBe("feature-remote-base");
      expect(await fs.readFile(path.join(environment.worktreePath!, "tracked.txt"), "utf8")).toBe("remote\n");
      expect(environment.createdFromCommit).toMatch(/^[0-9a-f]{40}$/);
      await expect(currentGitCommit(environment.worktreePath!)).resolves.toBe(environment.createdFromCommit);
    } finally {
      if (environment.worktreePath) await fs.rm(environment.worktreePath, { recursive: true, force: true });
    }
  });

  test("copies configured gitignored files into new local worktrees", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    await fs.writeFile(path.join(worktree, ".gitignore"), "environments.json\nnested/secret.json\n");
    await runGit(worktree, ["add", ".gitignore"]);
    await runGit(worktree, ["commit", "-m", "ignore copied files"]);
    await runGit(worktree, ["push", "origin", "main"]);
    await fs.mkdir(path.join(worktree, "nested"), { recursive: true });
    await fs.writeFile(path.join(worktree, "environments.json"), "{\"local\":true}\n");
    await fs.writeFile(path.join(worktree, "nested", "secret.json"), "{\"nested\":true}\n");
    await runGit(worktree, ["check-ignore", "environments.json"]);

    const environment = createEnvironment({
      status: "stopped",
      worktreePath: undefined,
      branch: "feature/copy-files",
      environmentType: "local",
    });
    const { context } = createContext(environment, {
      project: {
        id: environment.projectId,
        name: `Copy Files ${randomUUID().slice(0, 8)}`,
        gitUrl: remote,
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
      repositoryConfig: {
        defaultBranch: "main",
        prBaseBranch: "main",
        filesToCopy: ["environments.json", "nested/secret.json"],
      },
    });
    const commands = createCommandRegistry();

    try {
      await expect(commands.get("start_environment")?.({ environmentId: environment.id }, context)).resolves.toEqual(expect.objectContaining({
        setupStarted: false,
        environment: expect.objectContaining({
          id: environment.id,
          status: "running",
        }),
      }));

      expect(environment.worktreePath).toBeDefined();
      expect(await fs.readFile(path.join(environment.worktreePath!, "environments.json"), "utf8")).toBe("{\"local\":true}\n");
      expect(await fs.readFile(path.join(environment.worktreePath!, "nested", "secret.json"), "utf8")).toBe("{\"nested\":true}\n");
    } finally {
      if (environment.worktreePath) await fs.rm(environment.worktreePath, { recursive: true, force: true });
    }
  });

  test("injects workspace artifact git excludes into local worktrees before status reads", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    const suffix = randomUUID().slice(0, 8);
    const environment = createEnvironment({
      status: "stopped",
      worktreePath: undefined,
      branch: `feature/artifact-excludes-${suffix}`,
      environmentType: "local",
    });
    const { context } = createContext(environment, {
      project: {
        id: environment.projectId,
        name: `Artifact Excludes ${suffix}`,
        gitUrl: remote,
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
      repositoryConfig: { defaultBranch: "main", prBaseBranch: "main" },
    });
    const commands = createCommandRegistry();

    try {
      await expect(commands.get("start_environment")?.({ environmentId: environment.id }, context)).resolves.toEqual(expect.objectContaining({
        setupStarted: false,
        environment: expect.objectContaining({
          id: environment.id,
          status: "running",
        }),
      }));

      expect(environment.worktreePath).toBeDefined();
      const worktreePath = environment.worktreePath!;
      const gitDir = await gitOutput(worktreePath, ["rev-parse", "--git-dir"]);
      const excludePath = await gitOutput(worktreePath, ["rev-parse", "--git-path", "info/exclude"]);
      expect(gitDir).not.toBe(".git");
      const excludeFile = path.isAbsolute(excludePath) ? excludePath : path.resolve(worktreePath, excludePath);
      await expect(fs.readFile(excludeFile, "utf8")).resolves.toContain(".orkestrator\n");

      await fs.writeFile(excludeFile, "existing-pattern");
      await fs.mkdir(path.join(worktreePath, ".orkestrator", "clipboard"), { recursive: true });
      await fs.writeFile(path.join(worktreePath, ".orkestrator", "clipboard", "image.png"), "binary");
      await fs.mkdir(path.join(worktreePath, ".claude"), { recursive: true });
      await fs.writeFile(path.join(worktreePath, ".claude", "settings.local.json"), "{}\n");

      const changes = await commands.get("get_local_git_status")?.(
        { worktreePath, targetBranch: "main" },
        context,
      ) as Array<{ path: string }>;

      expect(changes.some((change) => change.path.startsWith(".orkestrator/"))).toBe(false);
      expect(changes.some((change) => change.path === ".claude/settings.local.json")).toBe(false);
      await expect(fs.readFile(excludeFile, "utf8")).resolves.toBe(
        "existing-pattern\n.orkestrator\n.claude/settings.local.json\n",
      );
      await expect(execFileAsync("git", ["-C", worktreePath, "check-ignore", ".orkestrator/clipboard/image.png", ".claude/settings.local.json"])).resolves.toBeDefined();
    } finally {
      if (environment.worktreePath) await fs.rm(environment.worktreePath, { recursive: true, force: true });
    }
  });

  test("rolls back a local worktree when a configured file is missing", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    const suffix = randomUUID().slice(0, 8);
    const projectName = `copy-missing-${suffix}`;
    const branch = `copy-missing-${suffix}`;
    const expectedWorktreePath = expectedManagedWorktreePath(projectName, branch);
    await fs.rm(expectedWorktreePath, { recursive: true, force: true });

    const environment = createEnvironment({
      status: "stopped",
      worktreePath: undefined,
      branch,
      environmentType: "local",
    });
    const { context, updates } = createContext(environment, {
      project: {
        id: environment.projectId,
        name: projectName,
        gitUrl: remote,
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
      repositoryConfig: {
        defaultBranch: "main",
        prBaseBranch: "main",
        filesToCopy: ["missing.json"],
      },
    });
    const commands = createCommandRegistry();

    try {
      await expect(commands.get("start_environment")?.({ environmentId: environment.id }, context)).rejects.toThrow(
        "Configured file to copy not found: missing.json",
      );

      expect(environment.status).toBe("error");
      expect(environment.worktreePath).toBeUndefined();
      expect(updates.map((update) => update.status)).toEqual(["creating", "error"]);
      await expectLocalWorktreeRolledBack(worktree, expectedWorktreePath, branch);
    } finally {
      await fs.rm(expectedWorktreePath, { recursive: true, force: true });
      await runGit(worktree, ["branch", "-D", branch]).catch(() => undefined);
    }
  });

  test("rolls back a local worktree when a configured path is a directory", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    await fs.mkdir(path.join(worktree, "nested-dir"), { recursive: true });
    const suffix = randomUUID().slice(0, 8);
    const projectName = `copy-directory-${suffix}`;
    const branch = `copy-directory-${suffix}`;
    const expectedWorktreePath = expectedManagedWorktreePath(projectName, branch);
    await fs.rm(expectedWorktreePath, { recursive: true, force: true });

    const environment = createEnvironment({
      status: "stopped",
      worktreePath: undefined,
      branch,
      environmentType: "local",
    });
    const { context, updates } = createContext(environment, {
      project: {
        id: environment.projectId,
        name: projectName,
        gitUrl: remote,
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
      repositoryConfig: {
        defaultBranch: "main",
        prBaseBranch: "main",
        filesToCopy: ["nested-dir"],
      },
    });
    const commands = createCommandRegistry();

    try {
      await expect(commands.get("start_environment")?.({ environmentId: environment.id }, context)).rejects.toThrow(
        "Configured path to copy is not a file: nested-dir",
      );

      expect(environment.status).toBe("error");
      expect(environment.worktreePath).toBeUndefined();
      expect(updates.map((update) => update.status)).toEqual(["creating", "error"]);
      await expectLocalWorktreeRolledBack(worktree, expectedWorktreePath, branch);
    } finally {
      await fs.rm(expectedWorktreePath, { recursive: true, force: true });
      await runGit(worktree, ["branch", "-D", branch]).catch(() => undefined);
    }
  });

  test("suffixes local worktree branches when origin has an unfetched branch with the stored name", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    const updater = await createTempDir("ork-electron-remote-branch-");
    await runGit(updater, ["clone", remote, "."]);
    await runGit(updater, ["checkout", "-b", "review-oauth-callback"]);
    await fs.writeFile(path.join(updater, "remote-only.txt"), "remote branch\n");
    await runGit(updater, ["add", "remote-only.txt"]);
    await runGit(updater, ["commit", "-m", "remote branch"]);
    await runGit(updater, ["push", "origin", "review-oauth-callback"]);

    const { stdout: knownBranches } = await execFileAsync("git", ["-C", worktree, "branch", "-a", "--format=%(refname:short)"]);
    expect(knownBranches).not.toContain("review-oauth-callback");

    const environment = createEnvironment({
      status: "stopped",
      worktreePath: undefined,
      branch: "review-oauth-callback",
      environmentType: "local",
    });
    const projectName = `Remote Branch Collision ${randomUUID().slice(0, 8)}`;
    const { context } = createContext(environment, {
      project: {
        id: environment.projectId,
        name: projectName,
        gitUrl: remote,
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
      repositoryConfig: { defaultBranch: "main", prBaseBranch: "main" },
    });
    const commands = createCommandRegistry();

    try {
      await expect(commands.get("start_environment")?.({ environmentId: environment.id }, context)).resolves.toEqual(expect.objectContaining({
        setupStarted: false,
        environment: expect.objectContaining({
          id: environment.id,
          status: "running",
        }),
      }));

      expect(environment.worktreePath).toBeDefined();
      expect(environment.branch).toBe("review-oauth-callback-1");
      await expect(currentGitBranch(environment.worktreePath!)).resolves.toBe("review-oauth-callback-1");
    } finally {
      if (environment.worktreePath) await fs.rm(environment.worktreePath, { recursive: true, force: true });
    }
  });

  test("creates local worktrees from a configured remote default branch", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    await runGit(worktree, ["checkout", "-b", "develop"]);
    await fs.writeFile(path.join(worktree, "tracked.txt"), "develop\n");
    await runGit(worktree, ["add", "tracked.txt"]);
    await runGit(worktree, ["commit", "-m", "develop base"]);
    await runGit(worktree, ["push", "-u", "origin", "develop"]);

    const environment = createEnvironment({
      status: "stopped",
      worktreePath: undefined,
      branch: "feature/custom-base",
      environmentType: "local",
    });
    const projectName = `Custom Base ${randomUUID().slice(0, 8)}`;
    const { context } = createContext(environment, {
      project: {
        id: environment.projectId,
        name: projectName,
        gitUrl: remote,
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
      repositoryConfig: { defaultBranch: "develop", prBaseBranch: "develop" },
    });
    const commands = createCommandRegistry();

    try {
      await expect(commands.get("start_environment")?.({ environmentId: environment.id }, context)).resolves.toEqual(expect.objectContaining({
        setupStarted: false,
        environment: expect.objectContaining({
          id: environment.id,
          status: "running",
        }),
      }));

      expect(environment.worktreePath).toBeDefined();
      expect(environment.branch).toBe("feature-custom-base");
      expect(await fs.readFile(path.join(environment.worktreePath!, "tracked.txt"), "utf8")).toBe("develop\n");
    } finally {
      if (environment.worktreePath) await fs.rm(environment.worktreePath, { recursive: true, force: true });
    }
  });

  test("marks local environment errored when the remote base branch is missing", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    const environment = createEnvironment({
      status: "stopped",
      worktreePath: undefined,
      branch: "feature/missing-base",
      environmentType: "local",
    });
    const { context, updates } = createContext(environment, {
      project: {
        id: environment.projectId,
        name: `Missing Base ${randomUUID().slice(0, 8)}`,
        gitUrl: remote,
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
      repositoryConfig: { defaultBranch: "missing-base", prBaseBranch: "missing-base" },
    });
    const commands = createCommandRegistry();

    await expect(commands.get("start_environment")?.({ environmentId: environment.id }, context)).rejects.toThrow();

    expect(environment.status).toBe("error");
    expect(environment.worktreePath).toBeUndefined();
    expect(updates.map((update) => update.status)).toEqual(["creating", "error"]);
  });

  test("marks local environment errored when the project repository has no origin remote", async () => {
    const repo = await createGitRepoOnBranch("main");
    const environment = createEnvironment({
      status: "stopped",
      worktreePath: undefined,
      branch: "feature/no-origin",
      environmentType: "local",
    });
    const { context, updates } = createContext(environment, {
      project: {
        id: environment.projectId,
        name: `No Origin ${randomUUID().slice(0, 8)}`,
        gitUrl: "",
        localPath: repo,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
      repositoryConfig: { defaultBranch: "main", prBaseBranch: "main" },
    });
    const commands = createCommandRegistry();

    await expect(commands.get("start_environment")?.({ environmentId: environment.id }, context)).rejects.toThrow();

    expect(environment.status).toBe("error");
    expect(environment.worktreePath).toBeUndefined();
    expect(updates.map((update) => update.status)).toEqual(["creating", "error"]);
  });

  test("matches short and full container IDs before removing orphaned Docker containers", async () => {
    const fullAssignedId = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    const shortAssignedId = fullAssignedId.slice(0, 12);
    const orphanId = "1234567890ab";
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: fullAssignedId,
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "ps" ]; then
  case "$*" in
    *ORKESTRATOR_SETUP_CAPABILITIES*)
      printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
      exit 0
      ;;
    *--prepare-only*)
      printf '\\036ORKESTRATOR_PREPARE_OK\\037'
      exit 0
      ;;
    *'{{json .}}'*)
      printf '{"ID":"${shortAssignedId}","Names":"assigned","Status":"Up","State":"running","Image":"orkestrator"}\\n'
      printf '{"ID":"${orphanId}","Names":"orphan","Status":"Exited","State":"exited","Image":"orkestrator"}\\n'
      ;;
    *)
      printf '${shortAssignedId}\\tassigned\\n'
      printf '${orphanId}\\torphan\\n'
      ;;
  esac
  exit 0
fi
if [ "$1" = "rm" ]; then
  printf '%s\\n' "$3" >> "$FAKE_DOCKER_RM_LOG"
  exit 0
fi
exit 0
`, async (logs) => {
      const containers = await commands.get("get_orkestrator_containers")?.({}, context) as Array<{ id: string; isAssigned: boolean; environmentId: string | null }>;
      expect(containers.find((container) => container.id === shortAssignedId)).toMatchObject({
        isAssigned: true,
        environmentId: "env-container",
      });
      expect(containers.find((container) => container.id === orphanId)).toMatchObject({ isAssigned: false });

      await expect(commands.get("cleanup_orphaned_containers")?.({}, context)).resolves.toBe(1);
      const removed = await fs.readFile(logs.rm, "utf8");
      expect(removed).toContain(orphanId);
      expect(removed).not.toContain(shortAssignedId);

      const dockerCalls = await fs.readFile(logs.all, "utf8");
      expect(dockerCalls).toContain("--no-trunc");
    });
  });

  test("persists the selected GitHub credential through stdin and container git config", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment, {
      globalConfig: {
        useHostGitHubCredentials: false,
        githubToken: "token-value",
      },
    });
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
  cat > "$FAKE_DOCKER_EXEC_LOG.stdin"
  exit 0
fi
exit 0
`, async (logs) => {
      await expect(commands.get("propagate_github_token_to_containers")?.({}, context)).resolves.toEqual({
        updated: ["env-container"],
        failed: [],
      });

      const execLog = await fs.readFile(logs.exec, "utf8");
      expect(execLog).toContain("git config --global --list");
      expect(execLog).toContain("--remove-section");
      expect(execLog).toContain("token_url=\"https://x-access-token:$token@github.com/\"");
      expect(execLog).toContain("git config --global --replace-all");
      expect(execLog).toContain("https://github.com/");
      expect(execLog).toContain("git@github.com:");
      expect(execLog).not.toContain("token-value");
      expect(await fs.readFile(`${logs.exec}.stdin`, "utf8")).toBe("token-value");
    });
  });

  test("clears persisted GitHub token rewrites when propagation receives an empty token", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment, {
      globalConfig: { useHostGitHubCredentials: false },
    });
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
  cat > "$FAKE_DOCKER_EXEC_LOG.stdin"
  exit 0
fi
exit 0
`, async (logs) => {
      await expect(commands.get("propagate_github_token_to_containers")?.({}, context)).resolves.toEqual({
        updated: ["env-container"],
        failed: [],
      });

      const execLog = await fs.readFile(logs.exec, "utf8");
      expect(execLog).toContain("grep '^url\\.https://x-access-token:'");
      expect(execLog).toContain("--remove-section");
      expect(await fs.readFile(`${logs.exec}.stdin`, "utf8")).toBe("");
    });
  });

  test("keeps credential sync compatible with repeated workspace Git configuration", async () => {
    const home = await createTempDir("ork-github-config-home-");
    const credentialFile = path.join(home, "runtime", "github-token");
    const env = { ...process.env, HOME: home, GITHUB_TOKEN: "token-value", GH_TOKEN: "" };
    const sync = spawnSync(
      "bash",
      ["-c", commandTesting.buildSyncContainerGitHubCredentialCommand(credentialFile)],
      { env, input: "token-value", encoding: "utf8" },
    );
    expect(sync.status).toBe(0);

    const workspaceSetup = await fs.readFile(
      path.join(process.cwd(), "docker", "workspace-setup.sh"),
      "utf8",
    );
    const start = workspaceSetup.indexOf('TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"');
    const end = workspaceSetup.indexOf("\nprint_workspace_disk_status()", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const credentialSetup = workspaceSetup.slice(start, end);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const configured = spawnSync("bash", ["-c", credentialSetup], {
        env,
        encoding: "utf8",
      });
      expect(configured.status).toBe(0);
    }

    const values = spawnSync("git", [
      "config",
      "--global",
      "--get-all",
      "url.https://x-access-token:token-value@github.com/.insteadOf",
    ], { env, encoding: "utf8" });
    expect(values.status).toBe(0);
    expect(values.stdout.trim().split("\n")).toEqual([
      "https://github.com/",
      "https://github.com",
      "git@github.com:",
    ]);
  });

  test("refreshes and clears the managed credential after direct container starts", async () => {
    const environment = createEnvironment({
      id: "env-direct-start",
      environmentType: "containerized",
      containerId: "container-1",
      status: "stopped",
    });
    const config = {
      version: "1.0.0",
      global: {
        useHostGitHubCredentials: false,
        githubToken: "rotated-token",
      },
      repositories: {},
    };
    const { context } = createContext(environment);
    context.storage.loadConfig = mock(async () => config);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "start" ]; then exit 0; fi
if [ "$1" = "exec" ]; then
  cat >> "$FAKE_DOCKER_EXEC_LOG.stdin"
  printf '\\n--sync--\\n' >> "$FAKE_DOCKER_EXEC_LOG.stdin"
  exit 0
fi
exit 1
`, async (logs) => {
      await commands.get("docker_start_container")?.({ containerId: "container-1" }, context);
      config.global.githubToken = "";
      await commands.get("docker_start_container")?.({ containerId: "container-1" }, context);

      const input = await fs.readFile(`${logs.exec}.stdin`, "utf8");
      expect(input).toBe("rotated-token\n--sync--\n\n--sync--\n");
      const calls = await fs.readFile(logs.all, "utf8");
      expect(calls.match(/start container-1/g)).toHaveLength(2);
    });
  });

  test("reports a credential sync failure after a direct container start", async () => {
    const { context } = createContext(createEnvironment(), {
      globalConfig: {
        useHostGitHubCredentials: false,
        githubToken: "secret-token",
      },
    });
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "start" ]; then exit 0; fi
if [ "$1" = "exec" ]; then
  token="$(cat)"
  printf 'sync rejected %s\\n' "$token" >&2
  exit 7
fi
exit 1
`, async () => {
      await expect(commands.get("docker_start_container")?.(
        { containerId: "container-1" },
        context,
      )).rejects.toThrow("sync rejected [REDACTED]");
    });
  });

  test("reports local git stats against origin target and includes untracked files", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged\n");
    await fs.writeFile(path.join(worktree, "new file.txt"), "one\ntwo\n");
    const commands = createCommandRegistry();

    const changes = await commands.get("get_local_git_status")?.(
      { worktreePath: worktree, targetBranch: "main" },
      createContext(createEnvironment()).context,
    ) as Array<{ path: string; additions: number; deletions: number; status: string }>;

    expect(changes).toContainEqual(expect.objectContaining({
      path: "tracked.txt",
      additions: 1,
      deletions: 0,
      status: "M",
    }));
    expect(changes).toContainEqual(expect.objectContaining({
      path: "new file.txt",
      additions: 2,
      deletions: 0,
      status: "?",
    }));
  });

  // Untracked files are line-counted by a streaming walk rather than by reading
  // and splitting the file, so these pin the counts the walk has to reproduce.
  test("counts untracked file lines across line endings, encodings and sizes", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const cases: Array<{ name: string; contents: Buffer | string; expected: number }> = [
      { name: "trailing-newline.txt", contents: "one\ntwo\n", expected: 2 },
      { name: "no-trailing-newline.txt", contents: "one\ntwo", expected: 2 },
      { name: "crlf.txt", contents: "one\r\ntwo\r\n", expected: 2 },
      { name: "cr-only.txt", contents: "one\rtwo\r", expected: 2 },
      { name: "mixed-endings.txt", contents: "one\r\ntwo\nthree\r", expected: 3 },
      { name: "single-newline.txt", contents: "\n", expected: 1 },
      { name: "no-newline-at-all.txt", contents: "solo", expected: 1 },
      { name: "empty.txt", contents: "", expected: 0 },
      { name: "unicode.txt", contents: "héllo 🌍\nsecond\n", expected: 2 },
      // Spans several 64KB read windows, including a separator pair that
      // straddles a window boundary.
      { name: "large.txt", contents: `${"x".repeat(65_535)}\r\n${"y".repeat(70_000)}\n`, expected: 2 },
      { name: "binary.bin", contents: Buffer.from([0x41, 0x00, 0x42, 0x0a]), expected: 0 },
    ];
    for (const { name, contents } of cases) {
      await fs.writeFile(path.join(worktree, name), contents);
    }
    const commands = createCommandRegistry();

    const changes = await commands.get("get_local_git_status")?.(
      { worktreePath: worktree, targetBranch: "main" },
      createContext(createEnvironment()).context,
    ) as Array<{ path: string; additions: number; status: string }>;

    for (const { name, expected } of cases) {
      expect(changes).toContainEqual(expect.objectContaining({
        path: name,
        additions: expected,
        status: "?",
      }));
    }
  });

  test("counts an oversized untracked file as zero rather than reading it", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const oversized = path.join(worktree, "oversized.log");
    const handle = await fs.open(oversized, "w");
    try {
      // Sparse: the size check must reject it without the content being read.
      await handle.truncate(11 * 1024 * 1024);
    } finally {
      await handle.close();
    }
    const commands = createCommandRegistry();

    const changes = await commands.get("get_local_git_status")?.(
      { worktreePath: worktree, targetBranch: "main" },
      createContext(createEnvironment()).context,
    ) as Array<{ path: string; additions: number; status: string }>;

    expect(changes).toContainEqual(expect.objectContaining({
      path: "oversized.log",
      additions: 0,
      status: "?",
    }));
  });

  test("does not follow an untracked symlink out of the worktree", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const outside = await createTempDir("ork-electron-outside-");
    const secretPath = path.join(outside, "secret.txt");
    await fs.writeFile(secretPath, "one\ntwo\nthree\nfour\nfive\n");
    await fs.symlink(secretPath, path.join(worktree, "link.txt"));
    const commands = createCommandRegistry();

    const changes = await commands.get("get_local_git_status")?.(
      { worktreePath: worktree, targetBranch: "main" },
      createContext(createEnvironment()).context,
    ) as Array<{ path: string; additions: number; status: string }>;

    expect(changes).toContainEqual(expect.objectContaining({
      path: "link.txt",
      additions: 0,
      status: "?",
    }));
  });

  test("counts every untracked file when there are more than the scan window", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const names = Array.from({ length: 40 }, (_, index) => `untracked-${index}.txt`);
    await Promise.all(names.map((name, index) =>
      fs.writeFile(path.join(worktree, name), `${"line\n".repeat(index + 1)}`)
    ));
    const commands = createCommandRegistry();

    const changes = await commands.get("get_local_git_status")?.(
      { worktreePath: worktree, targetBranch: "main" },
      createContext(createEnvironment()).context,
    ) as Array<{ path: string; additions: number; status: string }>;

    // Concurrency must not drop, duplicate or misalign a result with its path.
    names.forEach((name, index) => {
      expect(changes).toContainEqual(expect.objectContaining({
        path: name,
        additions: index + 1,
        status: "?",
      }));
    });
  });

  test("resolves a commit-pinned baseline without fetching from the remote", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const creationCommit = await currentGitCommit(worktree);
    await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged\n");
    const commands = createCommandRegistry();

    await withGitSubcommandLog("fetch", async (logPath) => {
      const changes = await commands.get("get_local_git_status")?.(
        { worktreePath: worktree, targetBranch: creationCommit },
        createContext(createEnvironment()).context,
      ) as Array<{ path: string; additions: number; status: string }>;

      expect(changes).toContainEqual(expect.objectContaining({
        path: "tracked.txt",
        additions: 1,
        status: "M",
      }));
      // A commit SHA names the same commit forever, so the network round trip
      // that every poll used to make cannot change the answer.
      await expect(fs.readFile(logPath, "utf8").catch(() => "")).resolves.toBe("");
    });
  });

  test("only treats an exact hexadecimal object id as an immutable baseline", () => {
    expect(isImmutableCommitRef("a".repeat(40))).toBe(true);
    expect(isImmutableCommitRef(`  ${"A1".repeat(20)}  `)).toBe(true);
    for (const ref of [
      "a".repeat(39),
      "a".repeat(41),
      "g".repeat(40),
      `refs/heads/${"a".repeat(40)}`,
      "",
    ]) {
      expect(isImmutableCommitRef(ref)).toBe(false);
    }
  });

  test("still fetches when the baseline is a branch that can move", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged\n");
    const commands = createCommandRegistry();

    await withGitSubcommandLog("fetch", async (logPath) => {
      await commands.get("get_local_git_status")?.(
        { worktreePath: worktree, targetBranch: "main" },
        createContext(createEnvironment()).context,
      );

      await expect(fs.readFile(logPath, "utf8")).resolves.toContain("fetch origin main");
    });
  });

  describe("backend-owned diff statistics", () => {
    function localDiffEnvironment(worktree: string) {
      const environment = createEnvironment({
        status: "stopped",
        environmentType: "local",
        worktreePath: worktree,
      });
      return { environment, ...createContext(environment) };
    }

    test("computes counts for a tracked local environment and announces them", async () => {
      const { worktree } = await createGitWorktreeWithOrigin();
      await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged\n");
      await fs.writeFile(path.join(worktree, "brand-new.txt"), "one\ntwo\n");
      const { environment, context, emitted } = localDiffEnvironment(worktree);
      const commands = createCommandRegistry();

      try {
        const snapshot = await commands.get("get_environment_diff_stats")?.({}, context) as {
          entries: Array<{ environmentId: string; comparisonRef: string; stats: Record<string, unknown> }>;
        };

        // The first call arms tracking, so the counts arrive with the scan that
        // follows rather than in the response itself.
        await waitForCondition(
          () => emitted.some((entry) => entry.event === "environment-diff-stats-changed"),
          "diff stats to be announced",
        );

        const change = emitted.find((entry) => entry.event === "environment-diff-stats-changed")
          ?.payload as { environmentId: string; comparisonRef: string; stats: Record<string, unknown> };
        expect(change.environmentId).toBe(environment.id);
        expect(change.comparisonRef).toBe("main");
        expect(change.stats).toEqual({
          additions: 3,
          deletions: 0,
          filesChanged: 2,
          truncated: false,
        });
        expect(Array.isArray(snapshot.entries)).toBe(true);

        // The snapshot is the rehydration path, so it must carry the same counts
        // a client would otherwise only have learned from the event.
        const rehydrated = await commands.get("get_environment_diff_stats")?.({}, context) as {
          entries: Array<{ environmentId: string; stats: Record<string, unknown> }>;
        };
        expect(rehydrated.entries).toContainEqual(expect.objectContaining({
          environmentId: environment.id,
          stats: { additions: 3, deletions: 0, filesChanged: 2, truncated: false },
        }));
      } finally {
        await commands.get("delete_environment")?.({ environmentId: environment.id }, context)
          .catch(() => undefined);
      }
    });

    // The sidebar badge and the Files panel used to ask for the same environment
    // separately; whichever arrives first now pays for the scan.
    test("serves the Files panel from the scan the badge already ran", async () => {
      const { worktree } = await createGitWorktreeWithOrigin();
      await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged\n");
      const { environment, context, emitted } = localDiffEnvironment(worktree);
      const commands = createCommandRegistry();

      try {
        await commands.get("get_environment_diff_stats")?.({}, context);
        await waitForCondition(
          () => emitted.some((entry) => entry.event === "environment-diff-stats-changed"),
          "diff stats to be announced",
        );

        await withGitSubcommandLog("status", async (logPath) => {
          const changes = await commands.get("get_local_git_status")?.(
            { worktreePath: worktree, targetBranch: "main" },
            context,
          ) as Array<{ path: string }>;

          expect(changes.some((change) => change.path === "tracked.txt")).toBe(true);
          await expect(fs.readFile(logPath, "utf8").catch(() => "")).resolves.toBe("");
        });
      } finally {
        await commands.get("delete_environment")?.({ environmentId: environment.id }, context)
          .catch(() => undefined);
      }
    });

    test("invalidates the shared file-list cache after local revert and delete", async () => {
      const { worktree } = await createGitWorktreeWithOrigin();
      await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged\n");
      const { environment, context, emitted } = localDiffEnvironment(worktree);
      const commands = createCommandRegistry();

      try {
        await commands.get("get_environment_diff_stats")?.({}, context);
        await waitForCondition(
          () => emitted.some((entry) => entry.event === "environment-diff-stats-changed"),
          "initial diff stats to be announced",
        );

        await commands.get("revert_local_file")?.(
          { environmentId: environment.id, filePath: "tracked.txt", targetBranch: "main" },
          context,
        );
        const immediate = await commands.get("get_local_git_status")?.(
          { worktreePath: worktree, targetBranch: "main" },
          context,
        ) as Array<{ path: string }>;

        expect(immediate.some((change) => change.path === "tracked.txt")).toBe(false);

        await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged again\n");
        emitted.splice(0);
        await commands.get("refresh_environment_diff_stats")?.(
          { environmentId: environment.id },
          context,
        );
        await waitForCondition(
          () => emitted.some((entry) =>
            entry.event === "environment-diff-stats-changed"
            && (entry.payload as { stats?: { additions?: number } }).stats?.additions === 1
          ),
          "changed file to be cached again",
        );

        await commands.get("delete_local_file")?.(
          { environmentId: environment.id, filePath: "tracked.txt" },
          context,
        );
        const afterDelete = await commands.get("get_local_git_status")?.(
          { worktreePath: worktree, targetBranch: "main" },
          context,
        ) as Array<{ path: string; status: string; additions: number; deletions: number }>;
        expect(afterDelete).toContainEqual(expect.objectContaining({
          path: "tracked.txt",
          status: "D",
          additions: 0,
          deletions: 1,
        }));
      } finally {
        await commands.get("delete_environment")?.({ environmentId: environment.id }, context)
          .catch(() => undefined);
      }
    });

    test("invalidates the shared file-list cache after container revert and delete", async () => {
      const environment = createEnvironment({
        id: "env-container-mutation-cache",
        environmentType: "containerized",
        worktreePath: undefined,
        containerId: "container-mutation-cache",
        status: "running",
      });
      const { context, emitted } = createContext(environment);
      const commands = createCommandRegistry();
      const responsePath = path.join(
        await createTempDir("ork-container-mutation-response-"),
        "response",
      );
      await fs.writeFile(
        responsePath,
        framedContainerGitStatus("M\0tracked.txt\0", "1\t0\ttracked.txt\0"),
      );
      const previousResponse = process.env.FAKE_CONTAINER_MUTATION_RESPONSE;
      process.env.FAKE_CONTAINER_MUTATION_RESPONSE = responsePath;

      try {
        await withFakeDocker(`#!/bin/sh
if [ "$1" = "exec" ]; then
  case "$*" in
    *ORKESTRATOR_NAME_STATUS*) cat "$FAKE_CONTAINER_MUTATION_RESPONSE" ;;
  esac
  exit 0
fi
exit 1
`, async () => {
          await commands.get("get_environment_diff_stats")?.({}, context);
          await waitForCondition(
            () => emitted.some((entry) => entry.event === "environment-diff-stats-changed"),
            "initial container diff stats to be announced",
          );
          await fs.writeFile(responsePath, framedContainerGitStatus());

          await commands.get("revert_container_file")?.(
            { environmentId: environment.id, filePath: "tracked.txt", targetBranch: "main" },
            context,
          );
          const afterRevert = await commands.get("get_git_status")?.(
            { containerId: environment.containerId, targetBranch: "main" },
            context,
          ) as Array<{ path: string }>;
          expect(afterRevert).toEqual([]);

          await fs.writeFile(
            responsePath,
            framedContainerGitStatus("M\0tracked.txt\0", "1\t0\ttracked.txt\0"),
          );
          emitted.splice(0);
          await commands.get("refresh_environment_diff_stats")?.(
            { environmentId: environment.id },
            context,
          );
          await waitForCondition(
            () => emitted.some((entry) =>
              entry.event === "environment-diff-stats-changed"
              && (entry.payload as { stats?: { additions?: number } }).stats?.additions === 1
            ),
            "container file to be cached again",
          );
          await fs.writeFile(responsePath, framedContainerGitStatus());

          await commands.get("delete_container_file")?.(
            { environmentId: environment.id, filePath: "tracked.txt" },
            context,
          );
          const afterDelete = await commands.get("get_git_status")?.(
            { containerId: environment.containerId, targetBranch: "main" },
            context,
          ) as Array<{ path: string }>;
          expect(afterDelete).toEqual([]);
        });
      } finally {
        if (previousResponse === undefined) delete process.env.FAKE_CONTAINER_MUTATION_RESPONSE;
        else process.env.FAKE_CONTAINER_MUTATION_RESPONSE = previousResponse;
      }
    });

    test("refreshes a tracked environment on explicit request", async () => {
      const { worktree } = await createGitWorktreeWithOrigin();
      await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged\n");
      const { environment, context, emitted } = localDiffEnvironment(worktree);
      const commands = createCommandRegistry();

      try {
        await commands.get("get_environment_diff_stats")?.({}, context);
        await waitForCondition(
          () => emitted.some((entry) => entry.event === "environment-diff-stats-changed"),
          "initial diff stats to be announced",
        );
        emitted.splice(0);
        await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged\nagain\n");

        await commands.get("refresh_environment_diff_stats")?.(
          { environmentId: environment.id },
          context,
        );
        await waitForCondition(
          () => emitted.some((entry) =>
            entry.event === "environment-diff-stats-changed"
            && (entry.payload as { stats?: { additions?: number } }).stats?.additions === 2
          ),
          "refreshed diff stats to be announced",
        );
      } finally {
        await commands.get("delete_environment")?.({ environmentId: environment.id }, context)
          .catch(() => undefined);
      }
    });

    test("clears published counts when a repository config retarget cannot be scanned", async () => {
      const { worktree } = await createGitWorktreeWithOrigin();
      await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged\n");
      const { environment, context, emitted } = localDiffEnvironment(worktree);
      const commands = createCommandRegistry();

      try {
        await commands.get("get_environment_diff_stats")?.({}, context);
        await waitForCondition(
          () => emitted.some((entry) => entry.event === "environment-diff-stats-changed"),
          "initial diff stats to be announced",
        );
        emitted.splice(0);

        await commands.get("update_repository_config")?.(
          {
            projectId: environment.projectId,
            repoConfig: { defaultBranch: "missing-base", prBaseBranch: "missing-base" },
          },
          context,
        );
        await waitForCondition(
          () => emitted.some((entry) =>
            entry.event === "environment-diff-stats-changed"
            && (entry.payload as { environmentId?: string; removed?: boolean }).environmentId === environment.id
            && (entry.payload as { removed?: boolean }).removed === true
          ),
          "retargeted counts to be removed",
        );

        const snapshot = await commands.get("get_environment_diff_stats")?.({}, context) as {
          entries: Array<{ environmentId: string }>;
        };
        expect(snapshot.entries).not.toContainEqual(expect.objectContaining({
          environmentId: environment.id,
        }));
      } finally {
        await commands.get("delete_environment")?.({ environmentId: environment.id }, context)
          .catch(() => undefined);
      }
    });

    test("does not resurrect deleted tracking from a stale reconciliation", async () => {
      const { worktree } = await createGitWorktreeWithOrigin();
      const environment = createEnvironment({
        id: "env-stale-sync",
        status: "stopped",
        worktreePath: worktree,
      });
      const { context, emitted } = createContext(environment);
      const commands = createCommandRegistry();
      await commands.get("get_environment_diff_stats")?.({}, context);
      await waitForCondition(
        () => emitted.some((entry) => entry.event === "environment-diff-stats-changed"),
        "initial diff tracking to start",
      );
      expect(commandTesting.trackedDiffStatsIds()).toContain(environment.id);

      const staleSnapshot = [environment];
      let releaseLoad!: () => void;
      let loadStarted!: () => void;
      const loadBlocked = new Promise<void>((resolve) => {
        releaseLoad = resolve;
      });
      const loadEntered = new Promise<void>((resolve) => {
        loadStarted = resolve;
      });
      let loadCount = 0;
      context.storage.loadEnvironments = mock(async () => {
        loadCount += 1;
        // Only the reconciliation snapshot is stale and blocked. Environment
        // deletion also loads the current environment set while cleaning tmux;
        // blocking that independent lifecycle read deadlocks the test itself.
        if (loadCount === 1) {
          loadStarted();
          await loadBlocked;
        }
        return staleSnapshot;
      });

      const rehydrate = commands.get("get_environment_diff_stats")?.({}, context);
      await loadEntered;
      await commands.get("delete_environment")?.({ environmentId: environment.id }, context);
      releaseLoad();
      await rehydrate;

      expect(commandTesting.trackedDiffStatsIds()).not.toContain(environment.id);
    });

    test("reads for itself when no recent scan is cached", async () => {
      const { worktree } = await createGitWorktreeWithOrigin();
      await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged\n");
      const { context } = localDiffEnvironment(worktree);
      const commands = createCommandRegistry();

      // Nothing armed tracking, so there is no cache to serve from.
      await withGitSubcommandLog("status", async (logPath) => {
        await commands.get("get_local_git_status")?.(
          { worktreePath: worktree, targetBranch: "main" },
          context,
        );

        await expect(fs.readFile(logPath, "utf8")).resolves.toContain("status");
      });
    });

    test("marks the counts approximate when the untracked scan is capped", async () => {
      const { worktree } = await createGitWorktreeWithOrigin();
      const overflow = path.join(worktree, "generated");
      await fs.mkdir(overflow, { recursive: true });
      // One past the 2000-file cap the scanner applies.
      await Promise.all(Array.from({ length: 2_001 }, (_, index) =>
        fs.writeFile(path.join(overflow, `file-${index}.txt`), "one\n")
      ));
      const { environment, context, emitted } = localDiffEnvironment(worktree);
      const commands = createCommandRegistry();

      try {
        await commands.get("get_environment_diff_stats")?.({}, context);
        await waitForCondition(
          () => emitted.some((entry) => entry.event === "environment-diff-stats-changed"),
          "capped diff stats to be announced",
          15_000,
        );

        const change = emitted.find((entry) => entry.event === "environment-diff-stats-changed")
          ?.payload as { stats: { truncated: boolean; filesChanged: number; additions: number } };
        expect(change.stats.truncated).toBe(true);
        // Every file is still listed; only the line counts past the cap are missing.
        expect(change.stats.filesChanged).toBe(2_001);
        expect(change.stats.additions).toBe(2_000);
      } finally {
        await commands.get("delete_environment")?.({ environmentId: environment.id }, context)
          .catch(() => undefined);
      }
    }, 30_000);

    test("does not mark the counts approximate for an ordinary worktree", async () => {
      const { worktree } = await createGitWorktreeWithOrigin();
      await fs.writeFile(path.join(worktree, "brand-new.txt"), "one\n");
      const { environment, context, emitted } = localDiffEnvironment(worktree);
      const commands = createCommandRegistry();

      try {
        await commands.get("get_environment_diff_stats")?.({}, context);
        await waitForCondition(
          () => emitted.some((entry) => entry.event === "environment-diff-stats-changed"),
          "diff stats to be announced",
        );

        const change = emitted.find((entry) => entry.event === "environment-diff-stats-changed")
          ?.payload as { stats: { truncated: boolean } };
        expect(change.stats.truncated).toBe(false);
      } finally {
        await commands.get("delete_environment")?.({ environmentId: environment.id }, context)
          .catch(() => undefined);
      }
    });

    test("marks capped container scans approximate and shares their file-list cache", async () => {
      const environment = createEnvironment({
        id: "env-container-diff-cap",
        environmentType: "containerized",
        worktreePath: undefined,
        containerId: "container-diff-cap",
        status: "running",
      });
      const { context, emitted } = createContext(environment);
      const commands = createCommandRegistry();
      const responsePath = path.join(
        await createTempDir("ork-container-diff-response-"),
        "response",
      );
      const names = Array.from({ length: 2_001 }, (_, index) => `generated/file-${index}.txt`);
      const untrackedStats = names
        .map((filePath, index) => `${index < 2_000 ? 1 : 0}\t${filePath}\0`)
        .join("");
      await fs.writeFile(
        responsePath,
        framedContainerGitStatus(
          "",
          "",
          untrackedStats,
        ),
      );
      const previousResponse = process.env.FAKE_CONTAINER_DIFF_RESPONSE;
      process.env.FAKE_CONTAINER_DIFF_RESPONSE = responsePath;

      try {
        await withFakeDocker(`#!/bin/sh
if [ "$1" = "exec" ]; then
  printf '%s\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
  cat "$FAKE_CONTAINER_DIFF_RESPONSE"
  exit 0
fi
exit 1
`, async (logs) => {
          await commands.get("get_environment_diff_stats")?.({}, context);
          await waitForCondition(
            () => emitted.some((entry) => entry.event === "environment-diff-stats-changed"),
            "container diff stats to be announced",
          );
          const change = emitted.find((entry) => entry.event === "environment-diff-stats-changed")
            ?.payload as { stats: { truncated: boolean; filesChanged: number; additions: number } };
          expect(change.stats).toEqual({
            additions: 2_000,
            deletions: 0,
            filesChanged: 2_001,
            truncated: true,
          });

          const execsBefore = (await fs.readFile(logs.exec, "utf8")).trim().split("\n").length;
          const files = await commands.get("get_git_status")?.(
            { containerId: environment.containerId, targetBranch: "main" },
            context,
          ) as Array<{ path: string }>;
          expect(files).toHaveLength(2_001);
          const execsAfter = (await fs.readFile(logs.exec, "utf8")).trim().split("\n").length;
          expect(execsAfter).toBe(execsBefore);
        });
      } finally {
        if (previousResponse === undefined) delete process.env.FAKE_CONTAINER_DIFF_RESPONSE;
        else process.env.FAKE_CONTAINER_DIFF_RESPONSE = previousResponse;
      }
    }, 15_000);

    // git status is dominated by walking and stat'ing the tree, and the
    // untracked cache is what stops it re-reading directories it has already
    // seen to be clean.
    test("enables git's scan caches on a newly created worktree", async () => {
      const { worktree, remote } = await createGitWorktreeWithOrigin();
      const suffix = randomUUID().slice(0, 8);
      const environment = createEnvironment({
        status: "stopped",
        worktreePath: undefined,
        branch: `feature/scan-caches-${suffix}`,
        environmentType: "local",
      });
      const { context, emitted } = createContext(environment, {
        project: {
          id: environment.projectId,
          name: `Scan Caches ${suffix}`,
          gitUrl: remote,
          localPath: worktree,
          addedAt: new Date(0).toISOString(),
          order: 0,
        },
        repositoryConfig: { defaultBranch: "main", prBaseBranch: "main" },
      });
      const commands = createCommandRegistry();

      try {
        await commands.get("start_environment")?.({ environmentId: environment.id }, context);
        const worktreePath = environment.worktreePath!;

        await waitForCondition(
          () => emitted.some((entry) =>
            entry.event === "environment-diff-stats-changed"
            && (entry.payload as { environmentId?: string }).environmentId === environment.id
          ),
          "new local environment diff tracking to start",
        );
        const snapshot = await commands.get("get_environment_diff_stats")?.({}, context) as {
          entries: Array<{ environmentId: string }>;
        };
        expect(snapshot.entries).toContainEqual(expect.objectContaining({
          environmentId: environment.id,
        }));

        await expect(gitOutput(worktreePath, ["config", "--get", "core.untrackedCache"]))
          .resolves.toBe("true");
        // Scoped to this worktree, never to the shared config: these worktrees
        // hang off a clone the user also drives by hand.
        await expect(gitOutput(worktreePath, ["config", "--worktree", "--get", "core.fsmonitor"]))
          .resolves.toBe("true");
        await expect(gitOutput(worktree, ["config", "--get", "core.fsmonitor"]).catch(() => ""))
          .resolves.not.toBe("true");
      } finally {
        await commands.get("delete_environment")?.({ environmentId: environment.id }, context)
          .catch(() => undefined);
      }
    });

    test("keeps scanning usable when Git rejects cache configuration", async () => {
      const { worktree } = await createGitWorktreeWithOrigin();

      await withFailingGitSubcommand("config", async () => {
        await expect(commandTesting.enableGitScanCaches(worktree)).resolves.toBeUndefined();
      });

      await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged\n");
      await expect(createCommandRegistry().get("get_local_git_status")?.(
        { worktreePath: worktree, targetBranch: "main" },
        createContext(createEnvironment()).context,
      )).resolves.toContainEqual(expect.objectContaining({
        path: "tracked.txt",
        additions: 1,
      }));
    });

    test("deleting an environment drops its counts from the snapshot", async () => {
      const { worktree } = await createGitWorktreeWithOrigin();
      await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged\n");
      const { environment, context, emitted } = localDiffEnvironment(worktree);
      const commands = createCommandRegistry();

      await commands.get("get_environment_diff_stats")?.({}, context);
      await waitForCondition(
        () => emitted.some((entry) => entry.event === "environment-diff-stats-changed"),
        "diff stats to be announced",
      );

      await commands.get("delete_environment")?.({ environmentId: environment.id }, context);

      const snapshot = await commands.get("get_environment_diff_stats")?.({}, context) as {
        entries: Array<{ environmentId: string }>;
      };
      expect(snapshot.entries.some((entry) => entry.environmentId === environment.id)).toBe(false);
    });
  });

  test("reports local git stats against an environment creation commit", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const creationCommit = await currentGitCommit(worktree);
    await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged\n");
    const commands = createCommandRegistry();

    const changes = await commands.get("get_local_git_status")?.(
      { worktreePath: worktree, targetBranch: creationCommit },
      createContext(createEnvironment()).context,
    ) as Array<{ path: string; additions: number; deletions: number; status: string }>;

    expect(changes).toContainEqual(expect.objectContaining({
      path: "tracked.txt",
      additions: 1,
      deletions: 0,
      status: "M",
    }));
  });

  test("can limit local git stats to committed changes since environment creation", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const creationCommit = await currentGitCommit(worktree);
    await fs.writeFile(path.join(worktree, "tracked.txt"), "base\ncommitted\n");
    await runGit(worktree, ["add", "tracked.txt"]);
    await runGit(worktree, ["commit", "-m", "branch change"]);
    await fs.writeFile(path.join(worktree, "tracked.txt"), "base\ncommitted\nuncommitted\n");
    await fs.writeFile(path.join(worktree, "untracked.txt"), "not committed\n");
    const commands = createCommandRegistry();

    const changes = await commands.get("get_local_git_status")?.(
      {
        worktreePath: worktree,
        targetBranch: creationCommit,
        includeUncommitted: false,
      },
      createContext(createEnvironment()).context,
    ) as Array<{ path: string; additions: number; deletions: number; status: string }>;

    expect(changes).toEqual([expect.objectContaining({
      path: "tracked.txt",
      additions: 1,
      deletions: 0,
      status: "M",
    })]);

    const changedSnapshot = await commands.get("get_local_git_status")?.(
      {
        worktreePath: worktree,
        targetBranch: creationCommit,
        includeUncommitted: false,
        knownDigest: "stale",
      },
      createContext(createEnvironment()).context,
    ) as {
      unchanged: boolean;
      digest: string;
      value?: unknown;
    };
    expect(changedSnapshot).toMatchObject({
      unchanged: false,
      value: changes,
    });
    await expect(commands.get("get_local_git_status")?.(
      {
        worktreePath: worktree,
        targetBranch: creationCommit,
        includeUncommitted: false,
        knownDigest: changedSnapshot.digest,
      },
      createContext(createEnvironment()).context,
    )).resolves.toEqual({
      unchanged: true,
      digest: changedSnapshot.digest,
    });
  });

  test("reads local branch files from origin and returns null for files missing in the base", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await fs.writeFile(path.join(worktree, "tracked.txt"), "local branch content\n");
    await runGit(worktree, ["add", "tracked.txt"]);
    await runGit(worktree, ["commit", "-m", "local-only-main-change"]);
    await fs.writeFile(path.join(worktree, "feature-only.txt"), "feature content\n");
    const commands = createCommandRegistry();

    await expect(commands.get("read_local_file_at_branch")?.(
      { worktreePath: worktree, filePath: "tracked.txt", branch: "main" },
      createContext(createEnvironment()).context,
    )).resolves.toMatchObject({
      path: "tracked.txt",
      content: "base\n",
      language: "txt",
    });

    await expect(commands.get("read_local_file_at_branch")?.(
      { worktreePath: worktree, filePath: "feature-only.txt", branch: "main" },
      createContext(createEnvironment()).context,
    )).resolves.toBeNull();

    await expect(commands.get("read_local_file_at_branch")?.(
      { worktreePath: worktree, filePath: "../outside.txt", branch: "main" },
      createContext(createEnvironment()).context,
    )).rejects.toThrow("Invalid filePath");
  });

  test("reverts tracked and newly added local files to the target branch", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await fs.writeFile(path.join(worktree, "tracked.txt"), "changed\n");
    await fs.writeFile(path.join(worktree, "new file.txt"), "new\n");
    await runGit(worktree, ["add", "tracked.txt", "new file.txt"]);
    const commands = createCommandRegistry();
    const environment = createEnvironment({ worktreePath: worktree });
    const context = createContext(environment).context;

    await expect(commands.get("revert_local_file")?.(
      { environmentId: environment.id, filePath: "tracked.txt", targetBranch: "main" },
      context,
    )).resolves.toBe("tracked.txt");
    await expect(commands.get("revert_local_file")?.(
      { environmentId: environment.id, filePath: "new file.txt", targetBranch: "main" },
      context,
    )).resolves.toBe("new file.txt");

    await expect(fs.readFile(path.join(worktree, "tracked.txt"), "utf8")).resolves.toBe("base\n");
    expect(existsSync(path.join(worktree, "new file.txt"))).toBe(false);
    expect(await gitOutput(worktree, ["status", "--porcelain"])).toBe("");
  });

  test("reverts both endpoints of a local rename", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await fs.writeFile(path.join(worktree, "original.txt"), "original\n");
    await runGit(worktree, ["add", "original.txt"]);
    await runGit(worktree, ["commit", "-m", "add original"]);
    await runGit(worktree, ["push", "origin", "main"]);
    await runGit(worktree, ["mv", "original.txt", "renamed.txt"]);
    const commands = createCommandRegistry();
    const environment = createEnvironment({ worktreePath: worktree });

    await expect(commands.get("revert_local_file")?.(
      { environmentId: environment.id, filePath: "renamed.txt", targetBranch: "main" },
      createContext(environment).context,
    )).resolves.toBe("renamed.txt");

    await expect(fs.readFile(path.join(worktree, "original.txt"), "utf8")).resolves.toBe("original\n");
    expect(existsSync(path.join(worktree, "renamed.txt"))).toBe(false);
    expect(await gitOutput(worktree, ["status", "--porcelain"])).toBe("");
  });

  test("deletes local files and stages tracked deletions for the next commit", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await fs.writeFile(path.join(worktree, "untracked.txt"), "untracked\n");
    const commands = createCommandRegistry();
    const environment = createEnvironment({ worktreePath: worktree });
    const context = createContext(environment).context;

    await expect(commands.get("delete_local_file")?.(
      { environmentId: environment.id, filePath: "tracked.txt" },
      context,
    )).resolves.toBe("tracked.txt");
    await expect(commands.get("delete_local_file")?.(
      { environmentId: environment.id, filePath: "untracked.txt" },
      context,
    )).resolves.toBe("untracked.txt");

    expect(existsSync(path.join(worktree, "tracked.txt"))).toBe(false);
    expect(existsSync(path.join(worktree, "untracked.txt"))).toBe(false);
    expect(await gitOutput(worktree, ["diff", "--cached", "--name-status"])).toBe("D\ttracked.txt");
  });

  test("rejects unsafe paths for local file mutations", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const commands = createCommandRegistry();
    const environment = createEnvironment({ worktreePath: worktree });
    const context = createContext(environment).context;

    await expect(commands.get("revert_local_file")?.(
      { environmentId: environment.id, filePath: "../outside.txt", targetBranch: "main" },
      context,
    )).rejects.toThrow("Invalid filePath");
    await expect(commands.get("delete_local_file")?.(
      { environmentId: environment.id, filePath: "../outside.txt" },
      context,
    )).rejects.toThrow("Invalid filePath");
    await expect(commands.get("revert_local_file")?.(
      { environmentId: environment.id, filePath: ".git/index", targetBranch: "main" },
      context,
    )).rejects.toThrow("Git metadata cannot be modified");
    await expect(commands.get("delete_local_file")?.(
      { environmentId: environment.id, filePath: ".git/index" },
      context,
    )).rejects.toThrow("Git metadata cannot be modified");
    expect(existsSync(path.join(worktree, ".git", "index"))).toBe(true);
  });

  test("rejects local mutations through symlinked ancestors without touching the target", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const outside = await createTempDir("ork-electron-outside-");
    const outsideFile = path.join(outside, "victim.txt");
    await fs.writeFile(outsideFile, "keep me\n");
    await fs.symlink(outside, path.join(worktree, "escape"));
    const commands = createCommandRegistry();
    const environment = createEnvironment({ worktreePath: worktree });
    const context = createContext(environment).context;

    await expect(commands.get("delete_local_file")?.(
      { environmentId: environment.id, filePath: "escape/victim.txt" },
      context,
    )).rejects.toThrow("symlink ancestor");
    await expect(commands.get("revert_local_file")?.(
      { environmentId: environment.id, filePath: "escape/victim.txt", targetBranch: "main" },
      context,
    )).rejects.toThrow("symlink ancestor");

    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("keep me\n");
  });

  test("handles missing ancestors and rejects non-directory ancestors for local deletion", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await fs.writeFile(path.join(worktree, "plain-file"), "not a directory\n");
    const commands = createCommandRegistry();
    const environment = createEnvironment({ worktreePath: worktree });
    const context = createContext(environment).context;

    await expect(commands.get("delete_local_file")?.(
      { environmentId: environment.id, filePath: "missing/child.txt" },
      context,
    )).resolves.toBe("missing/child.txt");
    await expect(commands.get("delete_local_file")?.(
      { environmentId: environment.id, filePath: "plain-file/child.txt" },
      context,
    )).rejects.toThrow("ancestor is not a directory");
    await expect(fs.readFile(path.join(worktree, "plain-file"), "utf8")).resolves.toBe(
      "not a directory\n",
    );
  });

  test("does not delete a local file when the revert target ref is missing", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await fs.writeFile(path.join(worktree, "tracked.txt"), "changed\n");
    const commands = createCommandRegistry();
    const environment = createEnvironment({ worktreePath: worktree });

    await expect(commands.get("revert_local_file")?.(
      { environmentId: environment.id, filePath: "tracked.txt", targetBranch: "missing-branch" },
      createContext(environment).context,
    )).rejects.toThrow("Target ref not found");
    await expect(fs.readFile(path.join(worktree, "tracked.txt"), "utf8")).resolves.toBe("changed\n");
  });

  test("does not treat a failed Git lookup as a path missing from the base", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await fs.writeFile(path.join(worktree, "tracked.txt"), "changed\n");
    const commands = createCommandRegistry();
    const environment = createEnvironment({ worktreePath: worktree });

    await withFailingGitSubcommand("ls-tree", async () => {
      await expect(commands.get("revert_local_file")?.(
        { environmentId: environment.id, filePath: "tracked.txt", targetBranch: "main" },
        createContext(environment).context,
      )).rejects.toThrow("forced ls-tree failure");
    });

    await expect(fs.readFile(path.join(worktree, "tracked.txt"), "utf8")).resolves.toBe("changed\n");
  });

  test("binds destructive local commands to a stored local environment", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const commands = createCommandRegistry();
    const localEnvironment = createEnvironment({ id: "env-local", worktreePath: worktree });
    const containerEnvironment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: "container-1",
    });
    const context = createContext([localEnvironment, containerEnvironment]).context;

    await expect(commands.get("delete_local_file")?.(
      { environmentId: "missing", filePath: "tracked.txt" },
      context,
    )).rejects.toThrow("Environment not found");
    await expect(commands.get("delete_local_file")?.(
      { environmentId: containerEnvironment.id, filePath: "tracked.txt" },
      context,
    )).rejects.toThrow("not a local worktree");

    await expect(fs.readFile(path.join(worktree, "tracked.txt"), "utf8")).resolves.toBe("base\n");
  });

  test("rejects unsafe target branch names before running git", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const commands = createCommandRegistry();
    const context = createContext(createEnvironment()).context;

    for (const branch of ["-rf", "feature..main", "feature//main", "bad name", "refs/.hidden"]) {
      await expect(commands.get("get_local_git_status")?.(
        { worktreePath: worktree, targetBranch: branch },
        context,
      )).rejects.toThrow("Invalid target branch");
      await expect(commands.get("read_local_file_at_branch")?.(
        { worktreePath: worktree, filePath: "tracked.txt", branch },
        context,
      )).rejects.toThrow("Invalid target branch");
    }
  });

  test("counts zero added lines for empty and binary untracked files", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await fs.writeFile(path.join(worktree, "empty.txt"), "");
    await fs.writeFile(path.join(worktree, "binary.bin"), Buffer.from([1, 2, 0, 3, 4]));
    const commands = createCommandRegistry();

    const changes = await commands.get("get_local_git_status")?.(
      { worktreePath: worktree, targetBranch: "main" },
      createContext(createEnvironment()).context,
    ) as Array<{ path: string; originalPath?: string; additions: number; deletions: number; status: string }>;

    expect(changes).toContainEqual(expect.objectContaining({ path: "empty.txt", additions: 0, status: "?" }));
    expect(changes).toContainEqual(expect.objectContaining({ path: "binary.bin", additions: 0, status: "?" }));
  });

  test("does not block local untracked scanning on a named pipe", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const fifoPath = path.join(worktree, "waiting.pipe");
    const created = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
    expect(created.status).toBe(0);

    await expect(commandTesting.countLocalFileLines(worktree, "waiting.pipe"))
      .resolves.toBe(0);
  });

  test("abandons line counting when an untracked file grows beyond the read cap", async () => {
    const read = mock(async (buffer: Buffer, offset: number, length: number) => {
      buffer.fill(0x61, offset, offset + length);
      return { bytesRead: length, buffer };
    });
    const openSpy = spyOn(fs, "open").mockResolvedValue({
      stat: mock(async () => ({ isFile: () => true, size: 1 })),
      read,
      close: mock(async () => undefined),
    } as never);

    try {
      await expect(commandTesting.countLocalFileLines("/unused", "growing.log"))
        .resolves.toBe(0);
      expect(read).toHaveBeenCalledTimes(161);
    } finally {
      openSpy.mockRestore();
    }
  });

  test("maps rename stats to the new path in local git status", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await fs.writeFile(path.join(worktree, "original.txt"), "a\nb\nc\nd\ne\n");
    await runGit(worktree, ["add", "original.txt"]);
    await runGit(worktree, ["commit", "-m", "add original"]);
    await runGit(worktree, ["push", "origin", "main"]);

    await fs.rm(path.join(worktree, "original.txt"));
    await fs.writeFile(path.join(worktree, "renamed.txt"), "a\nb\nc\nd\ne\nf\n");
    await runGit(worktree, ["add", "-A"]);
    await runGit(worktree, ["commit", "-m", "rename with edit"]);
    const commands = createCommandRegistry();

    const changes = await commands.get("get_local_git_status")?.(
      { worktreePath: worktree, targetBranch: "main" },
      createContext(createEnvironment()).context,
    ) as Array<{ path: string; additions: number; deletions: number; status: string }>;

    const renamed = changes.find((change) => change.path === "renamed.txt");
    expect(renamed).toBeDefined();
    expect(renamed?.status.startsWith("R")).toBe(true);
    expect(renamed?.originalPath).toBe("original.txt");
    expect(renamed?.additions).toBe(1);
  });

  test("preserves unusual Git paths and binary stats in NUL-delimited output", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const textPaths = [
      "literal => arrow.txt",
      "brace{name}.txt",
      "tab\tname.txt",
      "line\nname.txt",
      "雪.txt",
    ];
    for (const filePath of textPaths) {
      await fs.writeFile(path.join(worktree, filePath), "base\n");
    }
    await fs.writeFile(path.join(worktree, "binary.bin"), Buffer.from([1, 0, 2]));
    await runGit(worktree, ["add", "-A"]);
    await runGit(worktree, ["commit", "-m", "add unusual paths"]);
    const base = await currentGitCommit(worktree);

    for (const filePath of textPaths) {
      await fs.writeFile(path.join(worktree, filePath), "base\nchanged\n");
    }
    await fs.writeFile(path.join(worktree, "binary.bin"), Buffer.from([3, 0, 4]));
    const changes = await createCommandRegistry().get("get_local_git_status")?.(
      { worktreePath: worktree, targetBranch: base },
      createContext(createEnvironment()).context,
    ) as Array<{ path: string; additions: number; deletions: number }>;

    for (const filePath of textPaths) {
      expect(changes).toContainEqual(expect.objectContaining({
        path: filePath,
        additions: 1,
        deletions: 0,
      }));
    }
    expect(changes).toContainEqual(expect.objectContaining({
      path: "binary.bin",
      additions: 0,
      deletions: 0,
    }));
  });

  test("parses copy tuples and rejects truncated or malformed Git tuples", () => {
    expect(commandTesting.parseGitFileChanges(
      "C100\0old{name}.txt\0new => \t雪.txt\0",
      "2\t1\t\0old{name}.txt\0new => \t雪.txt\0",
    )).toEqual([expect.objectContaining({
      status: "C100",
      originalPath: "old{name}.txt",
      path: "new => \t雪.txt",
      additions: 2,
      deletions: 1,
    })]);
    expect(commandTesting.parseGitFileChanges(
      "M\0binary.bin\0M\0without-stats.txt\0",
      "-\t-\tbinary.bin\0",
    )).toEqual([
      expect.objectContaining({ path: "binary.bin", additions: 0, deletions: 0 }),
      expect.objectContaining({ path: "without-stats.txt", additions: 0, deletions: 0 }),
    ]);

    for (const [nameStatus, numstat] of [
      ["M\0missing-terminator", "1\t0\tfile.txt\0"],
      ["R100\0old.txt\0", "1\t0\t\0old.txt\0new.txt\0"],
      ["M\0file.txt\0", "bad\t0\tfile.txt\0"],
      ["M\0file.txt\0", "1\t0\t\0old-only.txt\0"],
    ]) {
      expect(() => commandTesting.parseGitFileChanges(nameStatus, numstat)).toThrow("Malformed");
    }
    for (const malformed of ["missing-nul", "x\tpath\0", "1\t\0"]) {
      expect(() => commandTesting.parseContainerUntrackedStats(malformed)).toThrow("Malformed");
    }
  });

  test("counts container untracked lines with bounded binary and symlink handling", async () => {
    const workspace = await createTempDir("ork-container-untracked-scanner-");
    const files = new Map<string, string | Buffer>([
      ["no-trailing.txt", "one\ntwo"],
      ["crlf.txt", "one\r\ntwo\r\n"],
      ["lone-cr.txt", "one\rtwo"],
      ["tab\tline\n雪.txt", "one\n"],
      ["empty.txt", ""],
      ["binary.bin", Buffer.from([1, 0, 2])],
      ["exact-limit.txt", "x".repeat(16)],
      ["over-limit.txt", "x".repeat(17)],
    ]);
    for (const [filePath, content] of files) {
      await fs.writeFile(path.join(workspace, filePath), content);
    }
    await fs.symlink("no-trailing.txt", path.join(workspace, "link.txt"));
    const status = [...files.keys(), "link.txt"]
      .map((filePath) => `?? ${filePath}\0`)
      .join("");
    const result = spawnSync(
      "node",
      ["-e", CONTAINER_UNTRACKED_STATS_SCANNER, "--", "16"],
      { cwd: workspace, input: Buffer.from(status), encoding: "utf8" },
    );
    expect(result.status).toBe(0);

    const changes = commandTesting.parseContainerUntrackedStats(result.stdout);
    expect(changes).toContainEqual(expect.objectContaining({ path: "no-trailing.txt", additions: 2 }));
    expect(changes).toContainEqual(expect.objectContaining({ path: "crlf.txt", additions: 2 }));
    expect(changes).toContainEqual(expect.objectContaining({ path: "lone-cr.txt", additions: 2 }));
    expect(changes).toContainEqual(expect.objectContaining({ path: "tab\tline\n雪.txt", additions: 1 }));
    expect(changes).toContainEqual(expect.objectContaining({ path: "empty.txt", additions: 0 }));
    expect(changes).toContainEqual(expect.objectContaining({ path: "binary.bin", additions: 0 }));
    expect(changes).toContainEqual(expect.objectContaining({ path: "exact-limit.txt", additions: 1 }));
    expect(changes).toContainEqual(expect.objectContaining({ path: "over-limit.txt", additions: 0 }));
    expect(changes).toContainEqual(expect.objectContaining({ path: "link.txt", additions: 0 }));
  });

  test("does not block container untracked scanning on a named pipe", async () => {
    const workspace = await createTempDir("ork-container-untracked-fifo-");
    const fifoPath = path.join(workspace, "waiting.pipe");
    const created = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
    expect(created.status).toBe(0);

    const result = spawnSync(
      "node",
      ["-e", CONTAINER_UNTRACKED_STATS_SCANNER, "--", "1024", "10"],
      {
        cwd: workspace,
        input: Buffer.from("?? waiting.pipe\0"),
        encoding: "utf8",
        timeout: 2_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(commandTesting.parseContainerUntrackedStats(result.stdout)).toEqual([
      expect.objectContaining({ path: "waiting.pipe", additions: 0 }),
    ]);
  });

  test("stops line-counting container files after the configured scan cap", async () => {
    const workspace = await createTempDir("ork-container-untracked-cap-");
    await Promise.all(["one.txt", "two.txt", "three.txt"].map((filePath) =>
      fs.writeFile(path.join(workspace, filePath), "one\ntwo\n")
    ));
    const result = spawnSync(
      "node",
      ["-e", CONTAINER_UNTRACKED_STATS_SCANNER, "--", "1024", "2"],
      {
        cwd: workspace,
        input: Buffer.from("?? one.txt\0?? two.txt\0?? three.txt\0"),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(commandTesting.parseContainerUntrackedStats(result.stdout)).toEqual([
      expect.objectContaining({ path: "one.txt", additions: 2 }),
      expect.objectContaining({ path: "two.txt", additions: 2 }),
      expect.objectContaining({ path: "three.txt", additions: 0 }),
    ]);
  });

  test("rejects every malformed Git tuple shape the framing can produce", () => {
    for (const [nameStatus, numstat] of [
      ["\0file.txt\0", ""],                          // name-status: empty status
      ["M\0\0", ""],                                 // name-status: empty path
      ["R100\0\0new.txt\0", ""],                     // name-status: empty rename source
      ["M\0file.txt\0", "10\0"],                     // numstat: header with no tab
      ["M\0file.txt\0", "10\t0\0"],                  // numstat: header with one tab
      ["M\0file.txt\0", "\t0\tfile.txt\0"],          // numstat: leading tab, no additions
      ["M\0file.txt\0", "1\t0\t\0\0\0"],             // numstat: rename record, empty result path
    ]) {
      expect(() => commandTesting.parseGitFileChanges(nameStatus, numstat)).toThrow("Malformed");
    }
  });

  test("rejects untracked scanner input that is not NUL-terminated", async () => {
    const workspace = await createTempDir("ork-container-untracked-truncated-");
    const result = spawnSync(
      "node",
      ["-e", CONTAINER_UNTRACKED_STATS_SCANNER, "--", "1024"],
      { cwd: workspace, input: Buffer.from("?? truncated.txt"), encoding: "utf8" },
    );
    expect(result.status).toBe(2);
  });

  test("counts only untracked porcelain records, skipping tracked and rename fields", async () => {
    const workspace = await createTempDir("ork-container-untracked-skip-");
    await fs.writeFile(path.join(workspace, "tracked.txt"), "one\ntwo\nthree\n");
    await fs.writeFile(path.join(workspace, "untracked.txt"), "one\n");
    await fs.mkdir(path.join(workspace, "a-directory"));
    // `git status --porcelain=v1 -z` emits a staged rename as two NUL fields, the
    // second carrying no status prefix at all. Reading that bare path as if it were
    // an untracked entry would report a tracked file's line count as an addition.
    const status = [
      " M tracked.txt\0",
      "R  renamed.txt\0tracked.txt\0",
      "?? untracked.txt\0",
      "?? a-directory\0",
    ].join("");
    const result = spawnSync(
      "node",
      ["-e", CONTAINER_UNTRACKED_STATS_SCANNER, "--", "1024"],
      { cwd: workspace, input: Buffer.from(status), encoding: "utf8" },
    );
    expect(result.status).toBe(0);

    const changes = commandTesting.parseContainerUntrackedStats(result.stdout);
    expect(changes.map((change) => change.path)).toEqual(["untracked.txt", "a-directory"]);
    expect(changes).toContainEqual(expect.objectContaining({ path: "untracked.txt", additions: 1 }));
    // A directory is opened successfully on both Linux and macOS, so the guard that
    // rejects it is the fstat check rather than the open itself.
    expect(changes).toContainEqual(expect.objectContaining({ path: "a-directory", additions: 0 }));
  });

  test("accepts only a full 40-character commit sha as a HEAD commit", () => {
    expect(commandTesting.parseHeadCommit("  1111111111111111111111111111111111111111\n"))
      .toBe("1111111111111111111111111111111111111111");
    expect(commandTesting.parseHeadCommit("ABCDEF1111111111111111111111111111111111"))
      .toBe("ABCDEF1111111111111111111111111111111111");
    for (const invalid of ["", "not-a-commit", "1111", "1".repeat(39), "1".repeat(41), "z".repeat(40)]) {
      expect(commandTesting.parseHeadCommit(invalid)).toBeUndefined();
    }
  });

  test("rejects a local HEAD that git did not report as a commit sha", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const environment = createEnvironment({
      id: "env-local-bad-head",
      environmentType: "local",
      worktreePath: worktree,
      setupScriptsComplete: false,
    });
    const { context } = createContext(environment);

    await withFakeGitSubcommandOutput("rev-parse", "not-a-commit", async () => {
      await expect(commandTesting.establishCreatedFromCommit(environment, context))
        .rejects.toThrow("Git returned an invalid HEAD commit");
    });
    expect(environment.createdFromCommit).toBeUndefined();
  });

  test("refuses to establish a baseline without a usable target", async () => {
    const local = createEnvironment({
      id: "env-baseline-no-worktree",
      environmentType: "local",
      worktreePath: undefined,
    });
    await expect(commandTesting.establishCreatedFromCommit(local, createContext(local).context))
      .rejects.toThrow("Local environment worktree is not available");

    const noContainer = createEnvironment({
      id: "env-baseline-no-container",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: null,
    });
    await expect(commandTesting.establishCreatedFromCommit(noContainer, createContext(noContainer).context))
      .rejects.toThrow("Environment has no container");

    const stopped = createEnvironment({
      id: "env-baseline-stopped-container",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: "container-1",
      status: "stopped",
    });
    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "inspect" ]; then
  printf 'exited\\n'
  exit 0
fi
exit 0
`, async (logs) => {
      await expect(commandTesting.establishCreatedFromCommit(stopped, createContext(stopped).context))
        .rejects.toThrow("Container is not running");
      const dockerLog = await fs.readFile(logs.all, "utf8");
      expect(dockerLog).not.toContain("--prepare-only");
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("captures the baseline once for callers that race outside the setup path", async () => {
    const environment = createEnvironment({
      id: "env-baseline-dedup",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment);

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
  case "$*" in
    *ORKESTRATOR_SETUP_CAPABILITIES*)
      printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
      exit 0
      ;;
    *--prepare-only*)
      printf '\\036ORKESTRATOR_PREPARE_OK\\037'
      exit 0
      ;;
    *rev-parse*)
      printf '5555555555555555555555555555555555555555\\n'
      ;;
  esac
  exit 0
fi
exit 0
`, async (logs) => {
      const [first, second] = await Promise.all([
        commandTesting.establishCreatedFromCommit(environment, context),
        commandTesting.establishCreatedFromCommit(environment, context),
      ]);

      expect(first.createdFromCommit).toBe("5555555555555555555555555555555555555555");
      // Both callers observe the identical resolution, which is only possible if
      // the second joined the first task rather than starting its own.
      expect(second).toBe(first);
      const execLog = await fs.readFile(logs.exec, "utf8");
      expect(execLog.split("\n").filter((line) => line.includes("--prepare-only"))).toHaveLength(1);
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("refuses to complete setup without a captured creation commit", async () => {
    const environment = createEnvironment({
      id: "env-complete-without-baseline",
      setupScriptsComplete: false,
    });
    const { context, emitted } = createContext(environment);

    await expect(commandTesting.completeEnvironmentSetup(environment, context))
      .rejects.toThrow("Environment creation commit was not captured before setup completed");
    expect(environment.setupScriptsComplete).toBe(false);
    expect(emitted).toEqual([]);
  });

  test("refuses to prepare a workspace on a base image that predates the prepare contract", async () => {
    const environment = createEnvironment({
      id: "env-container-stale-image",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    // An older image's workspace-setup.sh has no argument handling at all: the
    // capability probe finds nothing, and invoking --prepare-only there would run
    // the whole setup - including repository-controlled commands, as root - before
    // HEAD is read, producing a baseline that is not a pre-setup one.
    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
exit 0
`, async (logs) => {
      await expect(commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      )).rejects.toThrow("Container base image is out of date");

      const dockerLog = await fs.readFile(logs.all, "utf8");
      expect(dockerLog).not.toContain("--prepare-only");
      expect(ptySpawn).not.toHaveBeenCalled();
      expect(environment.createdFromCommit).toBeUndefined();
      expect(environment.setupScriptsComplete).toBe(false);
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("rejects a preparation run that never reports completion", async () => {
    const environment = createEnvironment({
      id: "env-container-prepare-silent",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  case "$*" in
    *ORKESTRATOR_SETUP_CAPABILITIES*)
      printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
      exit 0
      ;;
    *--prepare-only*)
      printf 'looks fine but never reached the checkpoint\\n'
      exit 0
      ;;
  esac
  exit 0
fi
exit 0
`, async () => {
      await expect(commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      )).rejects.toThrow("did not report completion");
      expect(ptySpawn).not.toHaveBeenCalled();
      expect(environment.createdFromCommit).toBeUndefined();
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("opens the setup terminal before preparation and streams the clone output into it", async () => {
    const environment = createEnvironment({
      id: "env-container-prepare-stream",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
    });
    const { context, emitted } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  case "$*" in
    *ORKESTRATOR_SETUP_CAPABILITIES*)
      printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
      exit 0
      ;;
    *--prepare-only*)
      printf 'Cloning into /workspace...\\n'
      printf '\\036ORKESTRATOR_PREPARE_OK\\037'
      exit 0
      ;;
    *rev-parse*)
      printf '6666666666666666666666666666666666666666\\n'
      ;;
  esac
  exit 0
fi
exit 0
`, async () => {
      const setupPromise = commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<Environment>;
      await waitForPtyProcessCount(1);
      ptyProcesses[0]?.emitData(SETUP_DONE_OSC);
      await setupPromise;

      const setupOutput = emitted
        .filter((entry) => entry.event === `terminal-output-${environment.id}:setup`)
        .map((entry) => (entry.payload as { text: string }).text)
        .join("");
      // Preparation performs the clone, so its announcement and output have to
      // reach the terminal before the setup commands are even known.
      expect(setupOutput).toContain("[orkestrator] Preparing workspace");
      expect(setupOutput).toContain("Cloning into /workspace...");
      expect(setupOutput.indexOf("[orkestrator] Preparing workspace")).toBeLessThan(
        setupOutput.indexOf("[orkestrator] Starting environment setup"),
      );
      // The buffer survives into the setup phase rather than being reset by it.
      expect(setupOutput.indexOf("Cloning into /workspace...")).toBeLessThan(
        setupOutput.indexOf("[orkestrator] Starting environment setup"),
      );
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("keeps the preparation session attachable before its setup PTY exists", async () => {
    const environment = createEnvironment({
      id: "env-container-prepare-attach",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const setupSessionId = `${environment.id}:setup`;

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  case "$*" in
    *ORKESTRATOR_SETUP_CAPABILITIES*)
      printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
      exit 0
      ;;
    *--prepare-only*)
      touch "$FAKE_DOCKER_LOG.preparing"
      while [ ! -f "$FAKE_DOCKER_LOG.release" ]; do
        sleep 0.01
      done
      printf '\\036ORKESTRATOR_PREPARE_OK\\037'
      exit 0
      ;;
    *rev-parse*)
      printf '6767676767676767676767676767676767676767\\n'
      ;;
  esac
  exit 0
fi
exit 0
`, async (logs) => {
      const setupPromise = commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<Environment>;
      let verificationError: unknown;
      try {
        await waitForCondition(
          () => existsSync(`${logs.all}.preparing`),
          "workspace preparation to start",
        );

        // Preparation owns a logical setup session before the PTY is spawned.
        // It must be attachable so the renderer subscribes once instead of
        // replaying the intro in a reconnect loop.
        expect(ptySpawn).not.toHaveBeenCalled();
        expect(
          commands.get("get_terminal_session")?.({ sessionId: setupSessionId }, context),
        ).toEqual({ id: setupSessionId, running: true });
        expect(
          await commands.get("get_environment_setup_session")?.(
            { environmentId: environment.id },
            context,
          ),
        ).toEqual(expect.objectContaining({
          sessionId: setupSessionId,
          running: true,
          terminalRunning: false,
        }));
      } catch (error) {
        verificationError = error;
      } finally {
        await fs.writeFile(`${logs.all}.release`, "");
      }

      await waitForPtyProcessCount(1);
      ptyProcesses[0]?.emitData(SETUP_DONE_OSC);
      await setupPromise;
      if (verificationError) throw verificationError;
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("does not attach an unknown setup session", async () => {
    const environment = createEnvironment({ id: "env-known-setup-session" });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const unknownSessionId = "env-unknown-setup-session:setup";

    expect(
      commands.get("get_terminal_session")?.({ sessionId: unknownSessionId }, context),
    ).toEqual({ id: unknownSessionId, running: false });
    expect(
      await commands.get("get_environment_setup_session")?.(
        { environmentId: "env-unknown-setup-session" },
        context,
      ),
    ).toBeNull();
  });

  test("closes the setup session when preparation fails", async () => {
    const environment = createEnvironment({
      id: "env-container-prepare-fails",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
      pendingAgentLaunch: true,
    });
    const { context, emitted } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  case "$*" in
    *ORKESTRATOR_SETUP_CAPABILITIES*)
      printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
      exit 0
      ;;
    *--prepare-only*)
      printf 'clone failed\\n' >&2
      exit 1
      ;;
  esac
  exit 0
fi
exit 0
`, async () => {
      await expect(commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      )).rejects.toThrow("clone failed");

      // A session opened for preparation must not be left claiming to be running
      // with no process behind it.
      const session = await commands.get("get_environment_setup_session")?.(
        { environmentId: environment.id },
        context,
      ) as { running: boolean; success?: boolean; error?: string };
      expect(session).toMatchObject({ running: false, success: false });
      expect(
        commands.get("get_terminal_session")?.(
          { sessionId: `${environment.id}:setup` },
          context,
        ),
      ).toEqual({ id: `${environment.id}:setup`, running: false });
      expect(session.error).toContain("clone failed");
      expect(emitted.some((entry) => entry.event === "environment-setup-complete"
        && (entry.payload as { success: boolean }).success === false)).toBe(true);
      expect(environment.pendingAgentLaunch).toBe(false);
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("increments the terminal transcript generation when setup is retried", async () => {
    const environment = createEnvironment({
      id: "env-container-prepare-generation",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
    });
    const { context, emitted } = createContext(environment);
    const commands = createCommandRegistry();
    const sessionId = `${environment.id}:setup`;

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  case "$*" in
    *ORKESTRATOR_SETUP_CAPABILITIES*)
      printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
      exit 0
      ;;
    *--prepare-only*)
      printf 'transient clone failure\\n' >&2
      exit 1
      ;;
  esac
fi
exit 0
`, async () => {
      await expect(commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      )).rejects.toThrow("transient clone failure");
      const firstSnapshot = commands.get("get_terminal_output_snapshot")?.(
        { sessionId },
        context,
      ) as { output: string; revision: number; generation: number };
      expect(firstSnapshot.generation).toBe(1);
      expect(firstSnapshot.revision).toBeGreaterThan(0);

      await expect(commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      )).rejects.toThrow("transient clone failure");
      const retrySnapshot = commands.get("get_terminal_output_snapshot")?.(
        { sessionId },
        context,
      ) as { output: string; revision: number; generation: number };
      expect(retrySnapshot.generation).toBe(2);
      expect(retrySnapshot.revision).toBeGreaterThan(0);

      const outputGenerations = emitted
        .filter(({ event }) => event === `terminal-output-${sessionId}`)
        .map(({ payload }) => (payload as { generation: number }).generation);
      expect(outputGenerations).toContain(1);
      expect(outputGenerations).toContain(2);
      expect(outputGenerations.indexOf(1)).toBeLessThan(outputGenerations.indexOf(2));
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("decodes sections whatever whitespace the container's base64 emits", () => {
    const nameStatus = "M\0keep.txt\0";
    const numstat = "1\t0\tkeep.txt\0";
    // GNU coreutils with -w0 emits no whitespace, macOS appends a trailing newline,
    // and an implementation that ignores -w0 wraps at 76 columns. All three decode.
    const variants = [
      (encoded: string) => encoded,
      (encoded: string) => `${encoded}\n`,
      (encoded: string) => (encoded.match(/.{1,4}/g) ?? []).join("\n"),
    ];
    for (const wrap of variants) {
      const response = [
        "ORKESTRATOR_NAME_STATUS",
        wrap(Buffer.from(nameStatus).toString("base64")),
        "ORKESTRATOR_NUMSTAT",
        wrap(Buffer.from(numstat).toString("base64")),
        "ORKESTRATOR_UNTRACKED",
        "",
        "ORKESTRATOR_END",
      ].join("");
      expect(commandTesting.parseContainerGitStatusResponse(response, true)).toEqual([
        expect.objectContaining({ path: "keep.txt", status: "M", additions: 1 }),
      ]);
    }
    // Stripping whitespace must not make genuinely invalid payloads decodable.
    expect(() => commandTesting.parseContainerGitStatusResponse(
      framedContainerGitStatus().replace(
        "ORKESTRATOR_NUMSTAT",
        "%%%ORKESTRATOR_NUMSTAT",
      ),
      true,
    )).toThrow("invalid base64");
  });

  test("closes the setup session when the terminal cannot be spawned after preparation", async () => {
    const environment = createEnvironment({
      id: "env-container-spawn-fails",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    // Preparation succeeds and opens the session, then the container disappears
    // before the setup PTY starts. Nothing but this path can close that session,
    // because no process was ever attached to it.
    let preparedOnce = false;
    await withFakeDocker(`#!/bin/sh
if [ "$1" = "inspect" ]; then
  if [ -f "$FAKE_DOCKER_LOG.prepared" ]; then
    printf 'exited\\n'
  else
    printf 'running\\n'
  fi
  exit 0
fi
if [ "$1" = "exec" ]; then
  case "$*" in
    *ORKESTRATOR_SETUP_CAPABILITIES*)
      printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
      exit 0
      ;;
    *--prepare-only*)
      printf '\\036ORKESTRATOR_PREPARE_OK\\037'
      exit 0
      ;;
    *rev-parse*)
      printf '7777777777777777777777777777777777777777\\n'
      touch "$FAKE_DOCKER_LOG.prepared"
      ;;
  esac
  exit 0
fi
exit 0
`, async () => {
      preparedOnce = true;
      await expect(commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      )).rejects.toThrow("Container is not running");

      const session = await commands.get("get_environment_setup_session")?.(
        { environmentId: environment.id },
        context,
      ) as { running: boolean; success?: boolean };
      expect(session).toMatchObject({ running: false, success: false });
      // The baseline was still captured and kept, so a retry does not re-prepare.
      expect(environment.createdFromCommit).toBe("7777777777777777777777777777777777777777");
      expect(environment.setupScriptsComplete).toBe(false);
      expect(ptySpawn).not.toHaveBeenCalled();
    });
    expect(preparedOnce).toBe(true);
  }, ASYNC_TEST_BUDGET_MS);

  test("reports a target ref the container cannot resolve", async () => {
    const environment = createEnvironment({
      id: "env-container-missing-ref",
      environmentType: "containerized",
      containerId: "container-1",
      worktreePath: undefined,
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "exec" ]; then
  printf '\\036ORKESTRATOR_TARGET_REF_NOT_FOUND\\037'
  exit 0
fi
exit 0
`, async () => {
      await expect(commands.get("get_git_status")?.(
        { containerId: "container-1", targetBranch: "main" },
        context,
      )).rejects.toThrow("Target ref is not present in the container: main");
    });
  });

  test("collects real git status through the composed container script", async () => {
    const repo = await createTempDir("ork-container-script-repo-");
    await runGit(repo, ["init", "-b", "main", "."]);
    await fs.writeFile(path.join(repo, "keep.txt"), "a\nb\nc\n");
    await fs.writeFile(path.join(repo, "old name.txt"), "x\ny\n");
    await runGit(repo, ["add", "-A"]);
    await runGit(repo, ["commit", "-m", "base"]);
    await runGit(repo, ["checkout", "-b", "work"]);
    await runGit(repo, ["mv", "old name.txt", "new\tname.txt"]);
    await fs.writeFile(path.join(repo, "keep.txt"), "a\nb\nc\nd\n");
    await runGit(repo, ["add", "-A"]);
    await runGit(repo, ["commit", "-m", "work"]);
    await fs.writeFile(path.join(repo, "untracked.txt"), "1\n2\n3");

    // Runs the composed program through a real shell, so `set -e -o pipefail`, the
    // base64 framing and the piped node scanner are exercised rather than asserted
    // as text against a fake `docker` that never interprets them.
    const script = commandTesting.buildContainerGitStatusScript("main", true);
    await withGnuBase64Shim(async (env) => {
      const result = spawnSync("bash", ["-c", script], { cwd: repo, encoding: "utf8", env });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);

      const changes = commandTesting.parseContainerGitStatusResponse(result.stdout, true);
      expect(changes).toContainEqual(expect.objectContaining({ path: "keep.txt", status: "M", additions: 1 }));
      expect(changes).toContainEqual(expect.objectContaining({
        path: "new\tname.txt",
        originalPath: "old name.txt",
      }));
      expect(changes).toContainEqual(expect.objectContaining({
        path: "untracked.txt",
        status: "?",
        additions: 3,
      }));
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("survives a login shell whose logout hook fails", async () => {
    const workspace = await createTempDir("ork-container-script-nonrepo-");
    const home = await createTempDir("ork-container-script-home-");
    // Debian's ~/.bash_logout runs `clear_console -q`, which fails when no console
    // is attached. Under `set -e` a failing logout hook replaces the script's own
    // exit status, which turned an empty status into an error for every workspace
    // that had not been cloned yet.
    await fs.writeFile(path.join(home, ".bash_logout"), "false\n");
    const loginEnv = { ...process.env, HOME: home };
    const script = commandTesting.buildContainerGitStatusScript("main", true);

    const nonRepo = spawnSync("bash", ["-lc", script], {
      cwd: workspace,
      encoding: "utf8",
      env: loginEnv,
    });
    expect(nonRepo.status).toBe(0);
    expect(nonRepo.stdout).toBe("");
    expect(commandTesting.parseContainerGitStatusResponse(nonRepo.stdout, true)).toEqual([]);

    const repo = await createTempDir("ork-container-script-missing-ref-");
    await runGit(repo, ["init", "-b", "work", "."]);
    await fs.writeFile(path.join(repo, "file.txt"), "a\n");
    await runGit(repo, ["add", "-A"]);
    await runGit(repo, ["commit", "-m", "base"]);
    const missingRef = spawnSync("bash", ["-lc", commandTesting.buildContainerGitStatusScript(
      "0123456789012345678901234567890123456789",
      true,
    )], { cwd: repo, encoding: "utf8", env: loginEnv });
    expect(missingRef.status).toBe(0);
    expect(commandTesting.isMissingTargetRefResponse(missingRef.stdout)).toBe(true);
  }, ASYNC_TEST_BUDGET_MS);

  test("redacts the GitHub token from propagation failure messages", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment, {
      globalConfig: {
        useHostGitHubCredentials: false,
        githubToken: "secret-token-123",
      },
    });
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  secret="$(cat)"
  printf 'credential update failed for %s\\n' "$secret" >&2
  exit 1
fi
exit 0
`, async () => {
      const result = await commands.get("propagate_github_token_to_containers")?.(
        {},
        context,
      ) as { updated: string[]; failed: [string, string][] };

      expect(result.updated).toEqual([]);
      expect(result.failed).toHaveLength(1);
      const [, message] = result.failed[0]!;
      expect(message).not.toContain("secret-token-123");
      expect(message).toContain("[REDACTED]");
    });
  });

  test("returns no container git changes before workspace clone creates a git repo", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
if [ "$1" = "exec" ]; then
  exit 0
fi
exit 1
`, async (logs) => {
      await expect(commands.get("get_git_status")?.(
        { containerId: "container-1", targetBranch: "main" },
        context,
      )).resolves.toEqual([]);

      const dockerExec = await fs.readFile(logs.exec, "utf8");
      expect(dockerExec).toContain("git rev-parse --is-inside-work-tree");
    });
  });

  test("injects workspace artifact git excludes before reading container git status", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const framedStatus = framedContainerGitStatus(
      "M\0tracked.txt\0",
      "1\t2\ttracked.txt\0",
    );

    await withFakeDocker(`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
if [ "$1" = "exec" ]; then
  printf '%s' '${framedStatus}'
  exit 0
fi
exit 1
`, async (logs) => {
      await expect(commands.get("get_git_status")?.(
        { containerId: "container-1", targetBranch: "main" },
        context,
      )).resolves.toEqual([expect.objectContaining({ path: "tracked.txt", status: "M" })]);

      const changedSnapshot = await commands.get("get_git_status")?.(
        {
          containerId: "container-1",
          targetBranch: "main",
          knownDigest: "stale",
        },
        context,
      ) as {
        unchanged: boolean;
        digest: string;
        value?: unknown;
      };
      expect(changedSnapshot).toMatchObject({
        unchanged: false,
        value: [expect.objectContaining({ path: "tracked.txt", status: "M" })],
      });
      await expect(commands.get("get_git_status")?.(
        {
          containerId: "container-1",
          targetBranch: "main",
          knownDigest: changedSnapshot.digest,
        },
        context,
      )).resolves.toEqual({
        unchanged: true,
        digest: changedSnapshot.digest,
      });

      const dockerExec = await fs.readFile(logs.exec, "utf8");
      expect(dockerExec).toContain("git rev-parse --is-inside-work-tree");
      expect(dockerExec).toContain("git rev-parse --git-path info/exclude");
      expect(dockerExec).toContain('for pattern in ".orkestrator" ".claude/settings.local.json"; do');
      expect(dockerExec).toContain('grep -qxF "$pattern" "$exclude_file"');
      expect(dockerExec).toContain("tail -c 1");
      expect(dockerExec).toContain('git diff --name-status -z -M "$base" $end_ref');
      expect(dockerExec).toContain('git diff --numstat -z -M "$base" $end_ref');
    });
  });

  test("maps container rename status to its destination and preserves the source path", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const commands = createCommandRegistry();
    const framedStatus = framedContainerGitStatus(
      "R100\0old name.ts\0new name.ts\0",
      "2\t1\t\0old name.ts\0new name.ts\0",
    );

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "exec" ]; then
  printf '%s' '${framedStatus}'
  exit 0
fi
exit 1
`, async () => {
      await expect(commands.get("get_git_status")?.(
        { containerId: "container-1", targetBranch: "main" },
        createContext(environment).context,
      )).resolves.toEqual([expect.objectContaining({
        path: "new name.ts",
        originalPath: "old name.ts",
        filename: "new name.ts",
        additions: 2,
        deletions: 1,
        status: "R100",
      })]);
    });
  });

  test("includes untracked container files only when working-tree changes are requested", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const commands = createCommandRegistry();
    const framedStatus = framedContainerGitStatus("", "", "2\tuntracked.txt\0");

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "exec" ]; then
  printf '%s' '${framedStatus}'
  exit 0
fi
exit 1
`, async () => {
      await expect(commands.get("get_git_status")?.(
        {
          containerId: "container-1",
          targetBranch: "0123456789012345678901234567890123456789",
          includeUncommitted: true,
        },
        createContext(environment).context,
      )).resolves.toEqual([expect.objectContaining({
        path: "untracked.txt",
        additions: 2,
        status: "?",
      })]);

      await expect(commands.get("get_git_status")?.(
        {
          containerId: "container-1",
          targetBranch: "0123456789012345678901234567890123456789",
          includeUncommitted: false,
        },
        createContext(environment).context,
      )).resolves.toEqual([]);
    });
  });

  test("uses HEAD and omits worktree scanning for committed-only container status", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const commands = createCommandRegistry();
    const framedStatus = framedContainerGitStatus(
      "M\0committed.txt\0",
      "1\t0\tcommitted.txt\0",
    );

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
if [ "$1" = "exec" ]; then
  printf '%s' '${framedStatus}'
  exit 0
fi
exit 1
`, async (logs) => {
      await expect(commands.get("get_git_status")?.(
        {
          containerId: "container-1",
          targetBranch: "0123456789012345678901234567890123456789",
          includeUncommitted: false,
        },
        createContext(environment).context,
      )).resolves.toEqual([expect.objectContaining({
        path: "committed.txt",
        additions: 1,
        status: "M",
      })]);

      const dockerExec = await fs.readFile(logs.exec, "utf8");
      expect(dockerExec).toContain("end_ref=HEAD");
      expect(dockerExec).toContain('git diff --name-status -z -M "$base" $end_ref');
      expect(dockerExec).not.toContain("git status --porcelain");
      expect(dockerExec).not.toContain("node -e");
    });
  });

  test("rejects unsafe container target refs before invoking Docker", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
exit 0
`, async (logs) => {
      for (const targetBranch of ["-rf", "feature..main", "feature//main", "bad name", "refs/.hidden"]) {
        await expect(commands.get("get_git_status")?.(
          { containerId: "container-1", targetBranch },
          createContext(environment).context,
        )).rejects.toThrow("Invalid target branch");
      }
      await expect(fs.readFile(logs.exec, "utf8")).rejects.toThrow();
    });
  });

  test("propagates a missing container target ref without returning an empty status", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "exec" ]; then
  printf 'Target ref not found: missing-branch\\n' >&2
  exit 2
fi
exit 1
`, async () => {
      await expect(commands.get("get_git_status")?.(
        { containerId: "container-1", targetBranch: "missing-branch" },
        createContext(environment).context,
      )).rejects.toThrow("Target ref not found");
    });
  });

  test("rejects malformed container status framing and invalid encoded sections", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const commands = createCommandRegistry();
    const malformedResponses = [
      "\u001eORKESTRATOR_NAME_STATUS\u001f",
      [
        "\u001eORKESTRATOR_NAME_STATUS\u001f",
        "%%%",
        "\u001eORKESTRATOR_NUMSTAT\u001f",
        "",
        "\u001eORKESTRATOR_UNTRACKED\u001f",
        "",
        "\u001eORKESTRATOR_END\u001f",
      ].join(""),
      `unexpected${framedContainerGitStatus()}`,
      `${framedContainerGitStatus()}unexpected`,
    ];

    for (const response of malformedResponses) {
      await withFakeDocker(`#!/bin/sh
if [ "$1" = "exec" ]; then
  printf '%s' '${response}'
  exit 0
fi
exit 1
`, async () => {
        await expect(commands.get("get_git_status")?.(
          { containerId: "container-1", targetBranch: "main" },
          createContext(environment).context,
        )).rejects.toThrow("Malformed");
      });
    }
  });

  test("does not confuse marker-like text in a container path with response framing", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const commands = createCommandRegistry();
    const markerPath = "src/\u001eORKESTRATOR_NUMSTAT\u001f.txt";
    const framedStatus = framedContainerGitStatus(
      `M\0${markerPath}\0`,
      `3\t1\t${markerPath}\0`,
    );

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "exec" ]; then
  printf '%s' '${framedStatus}'
  exit 0
fi
exit 1
`, async () => {
      await expect(commands.get("get_git_status")?.(
        { containerId: "container-1", targetBranch: "main" },
        createContext(environment).context,
      )).resolves.toEqual([expect.objectContaining({
        path: markerPath,
        additions: 3,
        deletions: 1,
      })]);
    });
  });

  test("runs validated container file revert and delete commands", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
exit 0
`, async (logs) => {
      await expect(commands.get("revert_container_file")?.(
        { environmentId: environment.id, filePath: "src/file name.ts", targetBranch: "main" },
        context,
      )).resolves.toBe("src/file name.ts");
      await expect(commands.get("delete_container_file")?.(
        { environmentId: environment.id, filePath: "src/file name.ts" },
        context,
      )).resolves.toBe("src/file name.ts");

      const dockerExec = await fs.readFile(logs.exec, "utf8");
      expect(dockerExec).toContain("set -euo pipefail");
      expect(dockerExec).toContain("git diff --name-status -z -M");
      expect(dockerExec).toContain("assert_safe_path \"$source_path\"");
      expect(dockerExec).toContain("git restore --source=\"$base\" --staged --worktree -- \"$candidate\"");
      expect(dockerExec).toContain("git rm -f --ignore-unmatch -- \"$candidate\"");
      expect(dockerExec).toContain("git clean -f -x -- \"$candidate\"");
      expect(dockerExec).toContain("Symlink ancestor is not allowed");
    });

    await expect(commands.get("revert_container_file")?.(
      { environmentId: environment.id, filePath: "../outside.ts", targetBranch: "main" },
      context,
    )).rejects.toThrow("Invalid filePath");
    await expect(commands.get("revert_container_file")?.(
      { environmentId: environment.id, filePath: "src/file.ts", targetBranch: "bad branch" },
      context,
    )).rejects.toThrow("Invalid target branch");
    await expect(commands.get("delete_container_file")?.(
      { environmentId: environment.id, filePath: ".git/index" },
      context,
    )).rejects.toThrow("Git metadata cannot be modified");
  });

  test("binds destructive container commands to a stored container environment", async () => {
    const localEnvironment = createEnvironment({
      id: "env-local",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      containerId: undefined,
    });
    const commands = createCommandRegistry();
    const context = createContext(localEnvironment).context;

    await expect(commands.get("delete_container_file")?.(
      { environmentId: "missing", filePath: "tracked.txt" },
      context,
    )).rejects.toThrow("Environment not found");
    await expect(commands.get("delete_container_file")?.(
      { environmentId: localEnvironment.id, filePath: "tracked.txt" },
      context,
    )).rejects.toThrow("not containerized");
  });

  liveDockerTest("executes rename-aware and containment-safe file mutations in a live container", async () => {
    const { stdout } = await execFileAsync("docker", [
      "run",
      "-d",
      "--rm",
      "--entrypoint",
      "sleep",
      "orkestrator-v2:latest",
      "infinity",
    ]);
    const containerId = stdout.trim();
    try {
      await execFileAsync("docker", ["exec", containerId, "bash", "-lc", `
        set -e
        find /workspace -mindepth 1 -maxdepth 1 -exec rm -rf {} +
        cd /workspace
        git init
        git checkout -b main
        git config user.name "Test User"
        git config user.email "test@example.com"
        printf 'original\\n' > original.txt
        git add original.txt
        git commit -m base
        git mv original.txt renamed.txt
        printf 'delete me\\n' > delete-me.txt
        mkdir -p /tmp/orkestrator-outside
        printf 'keep me\\n' > /tmp/orkestrator-outside/victim.txt
        ln -s /tmp/orkestrator-outside escape
      `]);
      const environment = createEnvironment({
        id: "env-live-container",
        environmentType: "containerized",
        containerId,
        worktreePath: undefined,
        status: "running",
      });
      const commands = createCommandRegistry();
      const context = createContext(environment).context;

      await expect(commands.get("revert_container_file")?.(
        { environmentId: environment.id, filePath: "renamed.txt", targetBranch: "main" },
        context,
      )).resolves.toBe("renamed.txt");
      await expect(commands.get("delete_container_file")?.(
        { environmentId: environment.id, filePath: "delete-me.txt" },
        context,
      )).resolves.toBe("delete-me.txt");
      await expect(commands.get("delete_container_file")?.(
        { environmentId: environment.id, filePath: "escape/victim.txt" },
        context,
      )).rejects.toThrow("Symlink ancestor is not allowed");

      await expect(execFileAsync("docker", ["exec", containerId, "bash", "-lc", [
        "test -f /workspace/original.txt",
        "test ! -e /workspace/renamed.txt",
        "test ! -e /workspace/delete-me.txt",
        "test -f /tmp/orkestrator-outside/victim.txt",
      ].join(" && ")])).resolves.toBeDefined();
    } finally {
      await execFileAsync("docker", ["rm", "-f", containerId]).catch(() => undefined);
    }
  });

  test("detects local PRs by listing all PRs for the environment branch", async () => {
    const worktreePath = await createTempDir("ork-electron-pr-worktree-");
    const environment = createEnvironment({ worktreePath, branch: "feature/pr" });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
printf '%s\\n' '[{"url":"https://github.com/acme/repo/pull/1","state":"CLOSED","mergeable":"MERGEABLE","updatedAt":"2026-01-01T00:00:00Z"},{"url":"https://github.com/acme/repo/pull/2","state":"OPEN","mergeable":"CONFLICTING","updatedAt":"2026-01-02T00:00:00Z"}]'
`, async (logPath) => {
      await expect(commands.get("detect_pr_local")?.(
        { environmentId: environment.id, branch: environment.branch },
        context,
      )).resolves.toEqual({
        url: "https://github.com/acme/repo/pull/2",
        state: "open",
        hasMergeConflicts: true,
      });

      const ghLog = await fs.readFile(logPath, "utf8");
      expect(ghLog).toContain("pr list --head feature/pr --state all --limit 30 --json url,state,mergeable,updatedAt");
    });
  });

  test("returns null when local PR listing reports no PRs", async () => {
    const worktreePath = await createTempDir("ork-electron-pr-empty-");
    const environment = createEnvironment({ worktreePath, branch: "feature/no-pr" });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
printf '[]\\n'
`, async () => {
      await expect(commands.get("detect_pr_local")?.(
        { environmentId: environment.id, branch: environment.branch },
        context,
      )).resolves.toBeNull();
    });
  });

  test.each([
    ["UNKNOWN mergeability", '"mergeable":"UNKNOWN"', null],
    ["missing mergeability", "", null],
    ["non-string mergeability", '"mergeable":42', null],
    ["lowercase mergeability", '"mergeable":"conflicting"', true],
  ] as const)("preserves %s from local PR list detection", async (_label, mergeableField, expected) => {
    const worktreePath = await createTempDir("ork-electron-pr-mergeability-");
    const environment = createEnvironment({ worktreePath, branch: "feature/mergeability" });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const comma = mergeableField ? `,${mergeableField}` : "";

    await withFakeGh(`#!/bin/sh
printf '%s\n' '[{"url":"https://github.com/acme/repo/pull/3","state":"OPEN"${comma},"updatedAt":"2026-01-03T00:00:00Z"}]'
`, async () => {
      await expect(commands.get("detect_pr_local")?.(
        { environmentId: environment.id, branch: environment.branch },
        context,
      )).resolves.toEqual({
        url: "https://github.com/acme/repo/pull/3",
        state: "open",
        hasMergeConflicts: expected,
      });
    });
  });

  test("surfaces gh failures during local PR detection", async () => {
    const worktreePath = await createTempDir("ork-electron-pr-fail-");
    const environment = createEnvironment({ worktreePath, branch: "feature/fail" });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(`#!/bin/sh
printf 'auth required\\n' >&2
exit 1
`, async () => {
      await expect(commands.get("detect_pr_local")?.(
        { environmentId: environment.id, branch: environment.branch },
        context,
      )).rejects.toThrow("auth required");
    });
  });

  test("throws when local PR detection output is not valid JSON", async () => {
    const worktreePath = await createTempDir("ork-electron-pr-badjson-");
    const environment = createEnvironment({ worktreePath, branch: "feature/bad" });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(`#!/bin/sh
printf 'not-json{\\n'
`, async () => {
      await expect(commands.get("detect_pr_local")?.(
        { environmentId: environment.id, branch: environment.branch },
        context,
      )).rejects.toThrow("Failed to parse gh pr list output");
    });
  });

  test("throws when local PR detection output is not a JSON array", async () => {
    const worktreePath = await createTempDir("ork-electron-pr-object-");
    const environment = createEnvironment({ worktreePath, branch: "feature/object" });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(`#!/bin/sh
printf '%s\\n' '{"url":"https://github.com/acme/repo/pull/1"}'
`, async () => {
      await expect(commands.get("detect_pr_local")?.(
        { environmentId: environment.id, branch: environment.branch },
        context,
      )).rejects.toThrow("Failed to parse gh pr list output");
    });
  });

  test("detects container PRs with gh pr list instead of gh pr view", async () => {
    const { context } = createContext(createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
      branch: "feature/container-pr",
    }));
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "exec" ]; then
  printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
  printf '%s\\n' '[{"url":"https://github.com/acme/repo/pull/9","state":"MERGED","mergeable":"MERGEABLE","updatedAt":"2026-01-03T00:00:00Z"}]'
  exit 0
fi
exit 0
`, async (logs) => {
      await expect(commands.get("detect_pr")?.(
        { containerId: "container-1", branch: "feature/container-pr" },
        context,
      )).resolves.toEqual({
        url: "https://github.com/acme/repo/pull/9",
        state: "merged",
        hasMergeConflicts: false,
      });

      const execLog = await fs.readFile(logs.exec, "utf8");
      expect(execLog).toContain("gh pr list --head 'feature/container-pr' --state all --limit 30 --json url,state,mergeable,updatedAt");
      expect(execLog).toContain("source /usr/local/bin/orkestrator-runtime-env.sh");
      expect(execLog).toContain("orkestrator_source_runtime_env");
      expect(execLog).not.toContain("gh pr view");
    });
  });

  test("reports a container PR as merged only after verifying the captured PR URL", async () => {
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
command=""
for arg in "$@"; do command="$arg"; done
command="$(printf '%s\\n' "$command" | tail -n 1)"
if [ "$command" = "'gh' 'pr' 'view' '--json' 'url' '--jq' '.url'" ]; then
  printf '%s\\n' 'https://github.com/acme/repo/pull/42'
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'view' 'https://github.com/acme/repo/pull/42' '--json' 'isDraft' '--jq' '.isDraft'" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'merge' 'https://github.com/acme/repo/pull/42' '--squash'" ]; then
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'view' 'https://github.com/acme/repo/pull/42' '--json' 'state' '--jq' '.state'" ]; then
  printf '%s\\n' 'MERGED'
  exit 0
fi
printf 'unexpected docker command: %s\\n' "$command" >&2
exit 1
`, async (logs) => {
      await expect(commands.get("merge_pr")?.(
        { containerId: "container-1", method: "squash", deleteBranch: false },
        context,
      )).resolves.toEqual({ outcome: "merged" });

      const execLog = await fs.readFile(logs.exec, "utf8");
      expect(execLog).toContain("'gh' 'pr' 'merge' 'https://github.com/acme/repo/pull/42' '--squash'");
      expect(execLog).toContain("'gh' 'pr' 'view' 'https://github.com/acme/repo/pull/42' '--json' 'state'");
    });
  });

  test("marks a draft container PR ready before merging it", async () => {
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
command=""
for arg in "$@"; do command="$arg"; done
command="$(printf '%s\\n' "$command" | tail -n 1)"
if [ "$command" = "'gh' 'pr' 'view' '--json' 'url' '--jq' '.url'" ]; then
  printf '%s\\n' 'https://github.com/acme/repo/pull/42'
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'view' 'https://github.com/acme/repo/pull/42' '--json' 'isDraft' '--jq' '.isDraft'" ]; then
  printf '%s\\n' 'true'
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'ready' 'https://github.com/acme/repo/pull/42'" ]; then
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'merge' 'https://github.com/acme/repo/pull/42' '--squash'" ]; then
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'view' 'https://github.com/acme/repo/pull/42' '--json' 'state' '--jq' '.state'" ]; then
  printf '%s\\n' 'MERGED'
  exit 0
fi
printf 'unexpected docker command: %s\\n' "$command" >&2
exit 1
`, async (logs) => {
      await expect(commands.get("merge_pr")?.(
        { containerId: "container-1", method: "squash", deleteBranch: false },
        context,
      )).resolves.toEqual({ outcome: "merged" });

      const execLog = await fs.readFile(logs.exec, "utf8");
      const readyCommand = "'gh' 'pr' 'ready' 'https://github.com/acme/repo/pull/42'";
      const mergeCommand = "'gh' 'pr' 'merge' 'https://github.com/acme/repo/pull/42' '--squash'";
      expect(execLog).toContain(readyCommand);
      expect(execLog.indexOf(readyCommand)).toBeLessThan(execLog.indexOf(mergeCommand));
    });
  });

  test("stops container merges when draft inspection or readiness fails", async () => {
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();

    for (const failure of ["draft-status", "ready"] as const) {
      await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
command=""
for arg in "$@"; do command="$arg"; done
command="$(printf '%s\\n' "$command" | tail -n 1)"
if [ "$command" = "'gh' 'pr' 'view' '--json' 'url' '--jq' '.url'" ]; then
  printf '%s\\n' 'https://github.com/acme/repo/pull/42'
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'view' 'https://github.com/acme/repo/pull/42' '--json' 'isDraft' '--jq' '.isDraft'" ]; then
  ${failure === "draft-status" ? "printf 'draft lookup failed\\n' >&2; exit 41" : "printf 'true\\n'; exit 0"}
fi
if [ "$command" = "'gh' 'pr' 'ready' 'https://github.com/acme/repo/pull/42'" ]; then
  printf 'ready failed\\n' >&2
  exit 42
fi
printf 'merge must not be submitted: %s\\n' "$command" >&2
exit 43
`, async (logs) => {
        await expect(commands.get("merge_pr")?.(
          { containerId: "container-1", method: "squash", deleteBranch: false },
          context,
        )).rejects.toThrow(failure === "draft-status" ? "draft lookup failed" : "ready failed");

        const execLog = await fs.readFile(logs.exec, "utf8");
        expect(execLog).not.toContain("'gh' 'pr' 'merge'");
      });
    }
  });

  test("reports a queued container PR as pending when the captured PR remains open", async () => {
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
command=""
for arg in "$@"; do command="$arg"; done
command="$(printf '%s\\n' "$command" | tail -n 1)"
if [ "$command" = "'gh' 'pr' 'view' '--json' 'url' '--jq' '.url'" ]; then
  printf '%s\\n' 'https://github.com/acme/repo/pull/42'
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'view' 'https://github.com/acme/repo/pull/42' '--json' 'isDraft' '--jq' '.isDraft'" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'merge' 'https://github.com/acme/repo/pull/42' '--rebase' '--delete-branch'" ]; then
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'view' 'https://github.com/acme/repo/pull/42' '--json' 'state' '--jq' '.state'" ]; then
  printf '%s\\n' 'OPEN'
  exit 0
fi
printf 'unexpected docker command: %s\\n' "$command" >&2
exit 1
`, async () => {
      await expect(commands.get("merge_pr")?.(
        { containerId: "container-1", method: "rebase", deleteBranch: true },
        context,
      )).resolves.toEqual({ outcome: "pending" });
    });
  });

  test("reports an unknown container merge outcome when post-submit verification fails", async () => {
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
command=""
for arg in "$@"; do command="$arg"; done
command="$(printf '%s\\n' "$command" | tail -n 1)"
if [ "$command" = "'gh' 'pr' 'view' '--json' 'url' '--jq' '.url'" ]; then
  printf '%s\\n' 'https://github.com/acme/repo/pull/42'
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'view' 'https://github.com/acme/repo/pull/42' '--json' 'isDraft' '--jq' '.isDraft'" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'merge' 'https://github.com/acme/repo/pull/42' '--merge'" ]; then
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'view' 'https://github.com/acme/repo/pull/42' '--json' 'state' '--jq' '.state'" ]; then
  printf '%s\\n' 'temporary verification failure' >&2
  exit 1
fi
printf 'unexpected docker command: %s\\n' "$command" >&2
exit 1
`, async () => {
      await expect(commands.get("merge_pr")?.(
        { containerId: "container-1", method: "merge", deleteBranch: false },
        context,
      )).resolves.toEqual({ outcome: "unknown" });
    });
  });

  test("merges local PRs through the GitHub API without updating worktree branches", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$5" = "isDraft" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42/merge" ] && [ "$3" = "--method" ] && [ "$4" = "PUT" ]; then
  printf '%s\\n' '{"merged":true}'
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`, async (logPath) => {
      await expect(commands.get("merge_pr_local")?.(
        { environmentId: environment.id, method: "squash", deleteBranch: false },
        context,
      )).resolves.toEqual({ outcome: "merged" });

      const ghLog = await fs.readFile(logPath, "utf8");
      expect(ghLog).toContain("api repos/acme/repo/pulls/42/merge --method PUT -f merge_method=squash");
      expect(ghLog).not.toContain("pr merge");
      expect(ghLog).not.toContain("--delete-branch");
    });
  });

  test("marks a draft local PR ready before merging it through the GitHub API", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-draft-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$5" = "isDraft" ]; then
  printf '%s\\n' 'true'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "ready" ]; then
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42/merge" ]; then
  printf '%s\\n' '{"merged":true}'
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`, async (logPath) => {
      await expect(commands.get("merge_pr_local")?.(
        { environmentId: environment.id, method: "squash", deleteBranch: false },
        context,
      )).resolves.toEqual({ outcome: "merged" });

      const ghLog = await fs.readFile(logPath, "utf8");
      const readyCommand = "pr ready https://github.com/acme/repo/pull/42";
      const mergeCommand = "api repos/acme/repo/pulls/42/merge";
      expect(ghLog).toContain(readyCommand);
      expect(ghLog.indexOf(readyCommand)).toBeLessThan(ghLog.indexOf(mergeCommand));
    });
  });

  test("stops local merges when draft inspection or readiness fails", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-failure-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    for (const failure of ["draft-status", "ready"] as const) {
      await withFakeGh(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  ${failure === "draft-status" ? "printf 'draft lookup failed\\n' >&2; exit 41" : "printf 'true\\n'; exit 0"}
fi
if [ "$1" = "pr" ] && [ "$2" = "ready" ]; then
  printf 'ready failed\\n' >&2
  exit 42
fi
printf 'merge must not be submitted: %s\\n' "$*" >&2
exit 43
`, async (logPath) => {
        await expect(commands.get("merge_pr_local")?.(
          { environmentId: environment.id, method: "squash", deleteBranch: false },
          context,
        )).rejects.toThrow(failure === "draft-status" ? "draft lookup failed" : "ready failed");

        const ghLog = await fs.readFile(logPath, "utf8");
        expect(ghLog).not.toContain("api repos/acme/repo/pulls/42/merge");
      });
    }
  });

  test("treats empty, null, and non-boolean draft output as non-draft", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-malformed-draft-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const previousStatus = process.env.FAKE_DRAFT_STATUS;

    try {
      for (const status of ["", "null", "unexpected"]) {
        process.env.FAKE_DRAFT_STATUS = status;
        await withFakeGh(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' "$FAKE_DRAFT_STATUS"
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42/merge" ]; then
  printf '%s\\n' '{"merged":true}'
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`, async (logPath) => {
          await expect(commands.get("merge_pr_local")?.(
            { environmentId: environment.id, method: "squash", deleteBranch: false },
            context,
          )).resolves.toEqual({ outcome: "merged" });

          const ghLog = await fs.readFile(logPath, "utf8");
          expect(ghLog).not.toContain("pr ready");
          expect(ghLog).toContain("api repos/acme/repo/pulls/42/merge");
        });
      }
    } finally {
      if (previousStatus === undefined) delete process.env.FAKE_DRAFT_STATUS;
      else process.env.FAKE_DRAFT_STATUS = previousStatus;
    }
  });

  test("deletes the remote head branch after local API merge when requested", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-delete-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$5" = "isDraft" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42" ] && [ "$3" = "" ]; then
  printf '%s\\n' '{"head":{"ref":"feature/local-work","repo":{"full_name":"acme/repo"}}}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42/merge" ] && [ "$3" = "--method" ] && [ "$4" = "PUT" ]; then
  printf '%s\\n' '{"merged":true}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/git/refs/heads/feature/local-work" ] && [ "$3" = "--method" ] && [ "$4" = "DELETE" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`, async (logPath) => {
      await expect(commands.get("merge_pr_local")?.(
        { environmentId: environment.id, method: "rebase", deleteBranch: true },
        context,
      )).resolves.toEqual({ outcome: "merged" });

      const ghLog = await fs.readFile(logPath, "utf8");
      expect(ghLog).toContain("api repos/acme/repo/pulls/42");
      expect(ghLog).toContain("api repos/acme/repo/pulls/42/merge --method PUT -f merge_method=rebase");
      expect(ghLog).toContain("api repos/acme/repo/git/refs/heads/feature/local-work --method DELETE");
      expect(ghLog).not.toContain("pr merge");
    });
  });

  test("defaults local API merge method to squash", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-default-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$5" = "isDraft" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42/merge" ] && [ "$3" = "--method" ] && [ "$4" = "PUT" ]; then
  printf '%s\\n' '{"merged":true}'
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`, async (logPath) => {
      await expect(commands.get("merge_pr_local")?.(
        { environmentId: environment.id, deleteBranch: false },
        context,
      )).resolves.toEqual({ outcome: "merged" });

      const ghLog = await fs.readFile(logPath, "utf8");
      expect(ghLog).toContain("api repos/acme/repo/pulls/42/merge --method PUT -f merge_method=squash");
    });
  });

  test("does not report a local API merge as successful without an explicit merged response", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-unconfirmed-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$5" = "isDraft" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42/merge" ]; then
  printf '%s\\n' '{"merged":false,"message":"Merge is pending"}'
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`, async () => {
      await expect(commands.get("merge_pr_local")?.(
        { environmentId: environment.id, method: "squash", deleteBranch: false },
        context,
      )).resolves.toEqual({ outcome: "unknown" });
    });
  });

  test("reports an unknown local API merge outcome when the response cannot be parsed", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-malformed-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(`#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$5" = "isDraft" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42/merge" ]; then
  printf '%s\\n' 'not-json'
  exit 0
fi
exit 1
`, async () => {
      await expect(commands.get("merge_pr_local")?.(
        { environmentId: environment.id, method: "squash", deleteBranch: false },
        context,
      )).resolves.toEqual({ outcome: "unknown" });
    });
  });

  test("rejects local API merge when the environment has no PR URL", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-no-pr-worktree-");
    const environment = createEnvironment({ worktreePath, prUrl: null });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await expect(commands.get("merge_pr_local")?.(
      { environmentId: environment.id, method: "squash", deleteBranch: false },
      context,
    )).rejects.toThrow("Local environment PR URL is not available");
  });

  test("releases local and container merge guards when lifecycle persistence fails", async () => {
    for (const kind of ["local", "container"] as const) {
      const environment = createEnvironment(kind === "local"
        ? {
          id: "env-local-lifecycle-failure",
          worktreePath: "/tmp/worktree",
          prUrl: "https://github.com/acme/repo/pull/42",
        }
        : {
          id: "env-container-lifecycle-failure",
          environmentType: "containerized",
          worktreePath: undefined,
          containerId: "container-1",
          status: "running",
        });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const updateEnvironment = context.storage.updateEnvironment.bind(context.storage);
      let failLifecycleWrite = true;
      context.storage.updateEnvironment = mock(async (
        environmentId: string,
        updates: Partial<Environment>,
      ) => {
        if (updates.lifecycleOperation === "merging" && failLifecycleWrite) {
          failLifecycleWrite = false;
          throw new Error("lifecycle storage unavailable");
        }
        return updateEnvironment(environmentId, updates);
      });

      const command = kind === "local" ? "merge_pr_local" : "merge_pr";
      const argumentsFor = (method: string) => kind === "local"
        ? { environmentId: environment.id, method, deleteBranch: false }
        : { containerId: environment.containerId, method, deleteBranch: false };

      await expect(commands.get(command)?.(
        argumentsFor("squash"),
        context,
      )).rejects.toThrow("lifecycle storage unavailable");

      // An invalid method fails after acquiring the guard. If the first call
      // leaked that guard, this would instead report "already being merged".
      await expect(commands.get(command)?.(
        argumentsFor("fast-forward"),
        context,
      )).rejects.toThrow("Invalid merge method: fast-forward");
    }
  });

  test("rejects invalid local API merge inputs before invoking gh", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-invalid-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
printf 'gh should not be called\\n' >&2
exit 1
`, async (logPath) => {
      await expect(commands.get("merge_pr_local")?.(
        { environmentId: environment.id, method: "fast-forward", deleteBranch: false },
        context,
      )).rejects.toThrow("Invalid merge method: fast-forward");

      environment.prUrl = "https://example.com/acme/repo/pull/42";
      await expect(commands.get("merge_pr_local")?.(
        { environmentId: environment.id, method: "squash", deleteBranch: false },
        context,
      )).rejects.toThrow("Invalid PR URL: https://example.com/acme/repo/pull/42");

      expect(existsSync(logPath)).toBe(false);
    });
  });

  test("ignores a 404 while deleting the remote head branch after local API merge", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-delete-404-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$5" = "isDraft" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42" ] && [ "$3" = "" ]; then
  printf '%s\\n' '{"head":{"ref":"feature/already-deleted","repo":{"full_name":"acme/repo"}}}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42/merge" ] && [ "$3" = "--method" ] && [ "$4" = "PUT" ]; then
  printf '%s\\n' '{"merged":true}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/git/refs/heads/feature/already-deleted" ] && [ "$3" = "--method" ] && [ "$4" = "DELETE" ]; then
  printf '%s\\n' 'HTTP 404: Not Found' >&2
  exit 1
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`, async (logPath) => {
      await expect(commands.get("merge_pr_local")?.(
        { environmentId: environment.id, method: "merge", deleteBranch: true },
        context,
      )).resolves.toEqual({ outcome: "merged" });

      const ghLog = await fs.readFile(logPath, "utf8");
      expect(ghLog).toContain("api repos/acme/repo/git/refs/heads/feature/already-deleted --method DELETE");
    });
  });

  test("propagates non-404 remote branch delete failures after local API merge", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-delete-fail-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$5" = "isDraft" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42" ] && [ "$3" = "" ]; then
  printf '%s\\n' '{"head":{"ref":"feature/protected","repo":{"full_name":"acme/repo"}}}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42/merge" ] && [ "$3" = "--method" ] && [ "$4" = "PUT" ]; then
  printf '%s\\n' '{"merged":true}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/git/refs/heads/feature/protected" ] && [ "$3" = "--method" ] && [ "$4" = "DELETE" ]; then
  printf '%s\\n' 'HTTP 403: Resource protected' >&2
  exit 1
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`, async () => {
      await expect(commands.get("merge_pr_local")?.(
        { environmentId: environment.id, method: "merge", deleteBranch: true },
        context,
      )).rejects.toThrow("HTTP 403: Resource protected");
    });
  });

  test("persists merge cleanup intent before dispatch and completes local cleanup in the backend", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-cleanup-local-");
    const environment = createEnvironment({
      id: "env-merge-cleanup-local",
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "open",
    });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();
    const task = {
      id: "task-merge-cleanup",
      environmentId: environment.id,
      status: "in-progress",
      prUrl: environment.prUrl,
      prState: "open",
      prMergeCommented: false,
      comments: [] as Array<{ text: string }>,
    };
    context.storage.getKanbanTasks = mock(async () => [task]) as typeof context.storage.getKanbanTasks;
    context.storage.updateKanbanTask = mock(async (
      _taskId: string,
      taskUpdates: Record<string, unknown>,
    ) => ({ ...task, ...taskUpdates })) as typeof context.storage.updateKanbanTask;
    context.storage.addKanbanComment = mock(async (
      _taskId: string,
      text: string,
    ) => ({ ...task, comments: [{ text }] })) as typeof context.storage.addKanbanComment;

    await withFakeGh(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42/merge" ]; then
  printf '%s\\n' '{"merged":true}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42" ]; then
  printf '%s\\n' '{"head":{"ref":"feature/backend-cleanup","repo":{"full_name":"acme/repo"}}}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/git/refs/heads/feature/backend-cleanup" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`, async (logPath) => {
      await expect(commands.get("merge_environment_pr")?.({
        environmentId: environment.id,
        method: "squash",
        deleteBranch: true,
        cleanupAfterMerge: true,
      }, context)).resolves.toEqual({
        outcome: "merged",
        cleanupOutcome: "completed",
      });

      const intentIndex = updates.findIndex((update) =>
        typeof update.cleanupAfterMergeRequestedAt === "string"
      );
      const mergingIndex = updates.findIndex((update) =>
        update.lifecycleOperation === "merging"
      );
      expect(intentIndex).toBeGreaterThanOrEqual(0);
      expect(mergingIndex).toBeGreaterThan(intentIndex);
      expect(updates).toContainEqual(expect.objectContaining({
        prState: "merged",
        hasMergeConflicts: false,
      }));
      expect(context.storage.updateKanbanTask).toHaveBeenCalledWith(
        task.id,
        { status: "review" },
      );
      expect(context.storage.addKanbanComment).toHaveBeenCalledWith(
        task.id,
        `🎉 PR merged: ${environment.prUrl}`,
      );
      expect(context.storage.updateKanbanTask).toHaveBeenLastCalledWith(
        task.id,
        {
          prUrl: environment.prUrl,
          prState: "merged",
          prMergeCommented: true,
        },
      );
      await expect(context.storage.getEnvironment(environment.id)).resolves.toBeNull();

      const ghLog = await fs.readFile(logPath, "utf8");
      expect(ghLog).toContain("api repos/acme/repo/pulls/42/merge --method PUT -f merge_method=squash");
      expect(ghLog).toContain("api repos/acme/repo/git/refs/heads/feature/backend-cleanup --method DELETE");
    });
  });

  test("keeps an unconfirmed container merge cleanup pending without deleting the environment", async () => {
    const environment = createEnvironment({
      id: "env-merge-cleanup-container-pending",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: "container-pending",
      status: "stopped",
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "open",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
command=""
for arg in "$@"; do command="$arg"; done
command="$(printf '%s\\n' "$command" | tail -n 1)"
if [ "$command" = "'gh' 'pr' 'view' '--json' 'url' '--jq' '.url'" ]; then
  printf '%s\\n' 'https://github.com/acme/repo/pull/42'
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'view' 'https://github.com/acme/repo/pull/42' '--json' 'isDraft' '--jq' '.isDraft'" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'merge' 'https://github.com/acme/repo/pull/42' '--rebase'" ]; then
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'view' 'https://github.com/acme/repo/pull/42' '--json' 'state' '--jq' '.state'" ]; then
  printf '%s\\n' 'OPEN'
  exit 0
fi
printf 'unexpected docker command: %s\\n' "$command" >&2
exit 1
`, async (logs) => {
      const result = await commands.get("merge_environment_pr")?.({
        environmentId: environment.id,
        method: "rebase",
        deleteBranch: true,
        cleanupAfterMerge: true,
      }, context);
      expect(result).toEqual({
        outcome: "pending",
        cleanupOutcome: "pending",
      });

      await expect(context.storage.getEnvironment(environment.id)).resolves.toMatchObject({
        cleanupAfterMergeRequestedAt: expect.any(String),
        cleanupAfterMergeError: null,
        prState: "open",
      });
      const execLog = await fs.readFile(logs.exec, "utf8");
      expect(execLog).toContain("'gh' 'pr' 'merge' 'https://github.com/acme/repo/pull/42' '--rebase'");
      expect(execLog).not.toContain("--delete-branch");
      expect(existsSync(logs.rm)).toBe(false);
    });
  });

  test("persists safe cleanup failure details and permits a backend deletion retry", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-cleanup-retry-");
    const environment = createEnvironment({
      id: "env-merge-cleanup-retry",
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "open",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const removeEnvironment = context.storage.removeEnvironment.bind(context.storage);
    context.storage.removeEnvironment = mock(async () => {
      throw { reason: "untrusted backend rejection" };
    });

    await withFakeGh(`#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42/merge" ]; then
  printf '%s\\n' '{"merged":true}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42" ]; then
  printf '%s\\n' '{"head":{"ref":"feature/retry","repo":{"full_name":"acme/repo"}}}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/git/refs/heads/feature/retry" ]; then
  exit 0
fi
exit 1
`, async () => {
      await expect(commands.get("merge_environment_pr")?.({
        environmentId: environment.id,
        method: "squash",
        deleteBranch: true,
        cleanupAfterMerge: true,
      }, context)).resolves.toEqual({
        outcome: "merged",
        cleanupOutcome: "failed",
        cleanupError: "An unexpected error occurred",
      });
      await expect(context.storage.getEnvironment(environment.id)).resolves.toMatchObject({
        deletionRequestedAt: expect.any(String),
        cleanupAfterMergeRequestedAt: expect.any(String),
        cleanupAfterMergeError: "An unexpected error occurred",
      });

      context.storage.removeEnvironment = removeEnvironment;
      await expect(commands.get("delete_environment")?.({
        environmentId: environment.id,
      }, context)).resolves.toBeUndefined();
      await expect(context.storage.getEnvironment(environment.id)).resolves.toBeNull();
    });
  });

  test("continues confirmed cleanup when persisting merged PR state fails once", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-cleanup-persist-fail-");
    const environment = createEnvironment({
      id: "env-merge-cleanup-persist-fail",
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "open",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const updateEnvironment = context.storage.updateEnvironment.bind(context.storage);
    let rejectedMergedState = false;
    context.storage.updateEnvironment = mock(async (
      environmentId: string,
      updates: Partial<Environment>,
    ) => {
      if (updates.prState === "merged" && !rejectedMergedState) {
        rejectedMergedState = true;
        throw new Error("storage temporarily unavailable");
      }
      return updateEnvironment(environmentId, updates);
    });

    await withFakeGh(`#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42/merge" ]; then
  printf '%s\\n' '{"merged":true}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42" ]; then
  printf '%s\\n' '{"head":{"ref":"feature/persist-fail","repo":{"full_name":"acme/repo"}}}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/git/refs/heads/feature/persist-fail" ]; then
  exit 0
fi
exit 1
`, async () => {
      await expect(commands.get("merge_environment_pr")?.({
        environmentId: environment.id,
        method: "merge",
        deleteBranch: true,
        cleanupAfterMerge: true,
      }, context)).resolves.toEqual({
        outcome: "merged",
        cleanupOutcome: "completed",
      });
      expect(rejectedMergedState).toBe(true);
      await expect(context.storage.getEnvironment(environment.id)).resolves.toBeNull();
    });
  });

  test("rehydration resumes only persisted cleanup after a merge was already confirmed", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-cleanup-recovery-");
    const environment = createEnvironment({
      id: "env-merge-cleanup-recovery",
      worktreePath,
      prUrl: null,
      prState: "merged",
      cleanupAfterMergeRequestedAt: "2026-07-28T12:00:00.000Z",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await expect(commands.get("get_environments")?.({
      projectId: environment.projectId,
    }, context)).resolves.toContainEqual(expect.objectContaining({
      id: environment.id,
      cleanupAfterMergeRequestedAt: "2026-07-28T12:00:00.000Z",
    }));

    await waitForCondition(
      () => !environment.cleanupAfterMergeRequestedAt
        || environment.deletionRequestedAt !== undefined,
      "persisted cleanup recovery to begin",
    );
    let recoveredEnvironment: Environment | null = environment;
    for (let attempt = 0; attempt < 100 && recoveredEnvironment; attempt += 1) {
      recoveredEnvironment = await context.storage.getEnvironment(environment.id);
      if (recoveredEnvironment) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    expect(recoveredEnvironment).toBeNull();
  });

  test("rejects a direct deletion while the backend merge guard is active", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-delete-race-");
    const environment = createEnvironment({
      id: "env-merge-delete-race",
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "open",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const updateEnvironment = context.storage.updateEnvironment.bind(context.storage);
    let releaseLifecycleWrite!: () => void;
    const lifecycleWriteReached = new Promise<void>((resolve) => {
      context.storage.updateEnvironment = mock(async (
        environmentId: string,
        updates: Partial<Environment>,
      ) => {
        if (updates.lifecycleOperation === "merging") {
          resolve();
          await new Promise<void>((release) => {
            releaseLifecycleWrite = release;
          });
        }
        return updateEnvironment(environmentId, updates);
      });
    });

    await withFakeGh(`#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42/merge" ]; then
  printf '%s\\n' '{"merged":true}'
  exit 0
fi
exit 1
`, async () => {
      const merge = commands.get("merge_environment_pr")?.({
        environmentId: environment.id,
        method: "squash",
        deleteBranch: false,
        cleanupAfterMerge: false,
      }, context);
      await lifecycleWriteReached;

      await expect(commands.get("delete_environment")?.({
        environmentId: environment.id,
      }, context)).rejects.toThrow(`Environment is currently being merged: ${environment.id}`);

      releaseLifecycleWrite();
      await expect(merge).resolves.toEqual({
        outcome: "merged",
        cleanupOutcome: "not-requested",
      });
    });
  });

  test("verifies a PR against the trusted project and environment branches", async () => {
    const worktreePath = await createTempDir("ork-electron-verify-pr-");
    const environment = createEnvironment({
      worktreePath,
      branch: "feature/local",
    });
    const { context } = createContext(environment, {
      project: {
        id: "project-1",
        name: "repo",
        gitUrl: "https://github.com/acme/repo.git",
        localPath: null,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
    });
    const commands = createCommandRegistry();

    await withFakeGh(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
printf '%s\\n' '{"url":"https://github.com/acme/repo/pull/42","headRefName":"feature/local","baseRefName":"main","state":"OPEN"}'
`, async (logPath) => {
      const verified = await commands.get("verify_environment_pr")?.({
        environmentId: environment.id,
        prUrl: "https://github.com/acme/repo/pull/42",
        targetBranch: "main",
      }, context);
      expect(verified).toEqual({
        url: "https://github.com/acme/repo/pull/42",
        headRefName: "feature/local",
        baseRefName: "main",
        state: "OPEN",
      });
      expect(await fs.readFile(logPath, "utf8")).toContain(
        "pr view https://github.com/acme/repo/pull/42 --json url,headRefName,baseRefName,state",
      );
    });

    await expect(commands.get("verify_environment_pr")?.({
      environmentId: environment.id,
      prUrl: "https://github.com/other/repo/pull/42",
      targetBranch: "main",
    }, context)).rejects.toThrow("different repository");
    await expect(commands.get("verify_environment_pr")?.({
      environmentId: environment.id,
      prUrl: "https://github.com/acme/repo/pull/42/",
      targetBranch: "main",
    }, context)).rejects.toThrow("canonical github.com URL");

    await withFakeGh(`#!/bin/sh
printf '%s\\n' '{"url":"https://github.com/acme/repo/pull/42","headRefName":"other-branch","baseRefName":"main","state":"OPEN"}'
`, async () => {
      await expect(commands.get("verify_environment_pr")?.({
        environmentId: environment.id,
        prUrl: "https://github.com/acme/repo/pull/42",
        targetBranch: "main",
      }, context)).rejects.toThrow("head branch does not match");
    });
  });

  test("deterministically generates refs, diff, Git-object contents, hashes, and validation evidence", async () => {
    const packageId = "package-1";
    const { worktreePath, artifactDirectory, baseRef, headRef, content } =
      await createReviewPackageWorktree({
        packageId,
        extraCommittedFiles: { "binary.dat": Buffer.from([0, 1, 2, 255]) },
      });
    await fs.writeFile(
      path.join(artifactDirectory, "validation-01.stdout.txt"),
      "TOKEN=visible-for-review\nall tests passed\n",
    );
    await fs.writeFile(
      path.join(artifactDirectory, "validation-01.stderr.txt"),
      "exact warning output\n",
    );
    await fs.writeFile(path.join(worktreePath, "review.txt"), "later worktree edit\n");
    await fs.writeFile(path.join(worktreePath, "unrelated.txt"), "leave me alone\n");
    const environment = createEnvironment({
      worktreePath,
      branch: "feature/local",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const args = {
      environmentId: environment.id,
      packageId,
      round: 2,
      targetBranch: "main",
      preparation: {
        validation: [{
          command: "bun test tests --parallel",
          status: "passed",
          exitCode: 0,
          stdoutPath:
            `.orkestrator/review-artifacts/${packageId}/validation-01.stdout.txt`,
          stderrPath:
            `.orkestrator/review-artifacts/${packageId}/validation-01.stderr.txt`,
          durationMs: 123,
          limitation: null,
        }],
        uncommittedFiles: [
          {
            path: "review.txt",
            reason: "Later user edit after the prepared commit.",
          },
          {
            path: "unrelated.txt",
            reason: "Unrelated user file.",
          },
        ],
        limitations: [],
      },
    };

    const command = commands.get("generate_looped_review_package")!;
    const first = await command(args, context) as Record<string, unknown>;
    const second = await command(args, context) as Record<string, unknown>;
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      id: packageId,
      round: 2,
      targetBranch: "main",
      baseRef,
      headRef,
      commit: {
        sha: headRef,
        subject: "change",
        committedFiles: ["binary.dat", "review.txt"],
      },
      changedFiles: [
        {
          path: "binary.dat",
          status: "A",
          content: null,
          contentSha256: null,
          omittedReason:
            "Binary content is represented by the complete binary Git diff.",
        },
        {
          path: "review.txt",
          status: "M",
          content,
          contentSha256: createHash("sha256").update(content).digest("hex"),
          omittedReason: null,
        },
      ],
      validation: [{
        command: "bun test tests --parallel",
        status: "passed",
        exitCode: 0,
        stdout: "TOKEN=visible-for-review\nall tests passed\n",
        stderr: "exact warning output\n",
        durationMs: 123,
        limitation: null,
      }],
      skippedFiles: [{
        path: "binary.dat",
        reason: "Binary content is represented by the complete binary Git diff.",
      }],
      uncommittedFiles: [
        {
          path: "review.txt",
          reason: "Later user edit after the prepared commit.",
        },
        {
          path: "unrelated.txt",
          reason: "Unrelated user file.",
        },
      ],
      limitations: [],
    });
    // The context key is deliberately absent rather than null. The workflow
    // supplies it, and a null is not a valid ReviewPackageContext — persisting
    // one made the snapshot fail validation on its very next read.
    expect(first).not.toHaveProperty("context");
    expect(first.completeDiff).toContain("diff --git a/review.txt b/review.txt");
    expect(first.completeDiff).toContain("GIT binary patch");
    expect(first.completeDiff).toMatch(/index [a-f0-9]{40}\.\.[a-f0-9]{40}/);

    await expect(command({
      ...args,
      preparation: {
        ...args.preparation,
        uncommittedFiles: [],
      },
    }, context)).rejects.toThrow("account for every uncommitted file");
    await expect(command({
      ...args,
      preparation: {
        ...args.preparation,
        validation: [{
          ...args.preparation.validation[0],
          stdoutPath: "../validation.stdout.txt",
        }],
      },
    }, context)).rejects.toThrow("parent directory traversal");

    // Agents commonly return the filename relative to the artifact directory
    // they were told to write into. Every spelling below names the same evidence
    // file, so all of them must produce the identical package.
    for (const [stdoutPath, stderrPath] of [
      ["validation-01.stdout.txt", "validation-01.stderr.txt"],
      ["./validation-01.stdout.txt", "./validation-01.stderr.txt"],
      [
        `.orkestrator\\review-artifacts\\${packageId}\\validation-01.stdout.txt`,
        `.orkestrator\\review-artifacts\\${packageId}\\validation-01.stderr.txt`,
      ],
      [
        `.orkestrator/review-artifacts/${packageId}/./validation-01.stdout.txt`,
        `.orkestrator/review-artifacts/${packageId}/./validation-01.stderr.txt`,
      ],
      // Only one of the pair needs rewriting for the package to stay identical.
      [
        "validation-01.stdout.txt",
        `.orkestrator/review-artifacts/${packageId}/validation-01.stderr.txt`,
      ],
    ]) {
      expect(await command({
        ...args,
        preparation: {
          ...args.preparation,
          validation: [{
            ...args.preparation.validation[0],
            stdoutPath,
            stderrPath,
          }],
        },
      }, context)).toEqual(first);
    }

    // Anchoring a bare filename must not widen which file the backend reads: the
    // resolved path is still compared against the one the backend computed.
    for (const stdoutPath of [
      "validation-02.stdout.txt",
      "validation-1.stdout.txt",
      "validation-01.stdout.text",
      ".orkestrator/review-artifacts/other-package/validation-01.stdout.txt",
      `.orkestrator/review-artifacts/${packageId}/nested/validation-01.stdout.txt`,
    ]) {
      await expect(command({
        ...args,
        preparation: {
          ...args.preparation,
          validation: [{ ...args.preparation.validation[0], stdoutPath }],
        },
      }, context)).rejects.toThrow("artifact paths are not deterministic");
    }

    // The rejection has to say what was expected, or a retrying agent has no way
    // to correct the path it sent.
    await expect(command({
      ...args,
      preparation: {
        ...args.preparation,
        validation: [{
          ...args.preparation.validation[0],
          stdoutPath: "validation-02.stdout.txt",
        }],
      },
    }, context)).rejects.toThrow(
      `expected .orkestrator/review-artifacts/${packageId}/validation-01.stdout.txt`,
    );

    for (const stdoutPath of [
      "/etc/passwd",
      ".git/config",
      "",
    ]) {
      await expect(command({
        ...args,
        preparation: {
          ...args.preparation,
          validation: [{ ...args.preparation.validation[0], stdoutPath }],
        },
      }, context)).rejects.toThrow(/Invalid validation\[0\]\.stdoutPath/);
    }
  });

  test("hydrates validation evidence by array position, counting skipped commands", async () => {
    const packageId = "package-ordinals";
    const { worktreePath, artifactDirectory } = await createReviewPackageWorktree({
      packageId,
    });
    // Entry 1 is skipped and writes nothing, so the commands that did run own
    // ordinals 02 and 03 rather than 01 and 02.
    await fs.writeFile(
      path.join(artifactDirectory, "validation-02.stdout.txt"),
      "all tests passed\n",
    );
    await fs.writeFile(
      path.join(artifactDirectory, "validation-02.stderr.txt"),
      "",
    );
    await fs.writeFile(
      path.join(artifactDirectory, "validation-03.stdout.txt"),
      "build output\n",
    );
    await fs.writeFile(
      path.join(artifactDirectory, "validation-03.stderr.txt"),
      "error TS2345: build failed\n",
    );
    const environment = createEnvironment({
      worktreePath,
      branch: "feature/local",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const command = commands.get("generate_looped_review_package")!;
    const skipped = {
      command: "bun run --cwd apps/ios typecheck",
      status: "skipped",
      exitCode: null,
      stdoutPath: null,
      stderrPath: null,
      durationMs: 0,
      limitation: "Xcode is unavailable in this environment.",
    };
    const passed = {
      command: "bun test tests --parallel",
      status: "passed",
      exitCode: 0,
      stdoutPath: `.orkestrator/review-artifacts/${packageId}/validation-02.stdout.txt`,
      stderrPath: `.orkestrator/review-artifacts/${packageId}/validation-02.stderr.txt`,
      durationMs: 4200,
      limitation: null,
    };
    const failed = {
      command: "bun run build",
      status: "failed",
      exitCode: 2,
      // Bare filenames resolve against the artifact directory at their own
      // ordinal, not against the first entry's.
      stdoutPath: "validation-03.stdout.txt",
      stderrPath: "validation-03.stderr.txt",
      durationMs: 900,
      limitation: "Build ran against a stale cache.",
    };
    const args = {
      environmentId: environment.id,
      packageId,
      round: 1,
      targetBranch: "main",
      preparation: {
        validation: [skipped, passed, failed],
        uncommittedFiles: [],
        limitations: [],
      },
    };

    const generated = await command(args, context) as Record<string, unknown>;
    expect(generated.validation).toEqual([
      {
        command: "bun run --cwd apps/ios typecheck",
        status: "skipped",
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
        limitation: "Xcode is unavailable in this environment.",
      },
      {
        command: "bun test tests --parallel",
        status: "passed",
        exitCode: 0,
        stdout: "all tests passed\n",
        stderr: "",
        durationMs: 4200,
        limitation: null,
      },
      {
        command: "bun run build",
        status: "failed",
        exitCode: 2,
        stdout: "build output\n",
        stderr: "error TS2345: build failed\n",
        durationMs: 900,
        limitation: "Build ran against a stale cache.",
      },
    ]);

    // Dropping the skipped entry shifts every later entry's ordinal. Numbering
    // by execution order instead of array position would accept this.
    await expect(command({
      ...args,
      preparation: { ...args.preparation, validation: [passed, failed] },
    }, context)).rejects.toThrow(
      `expected .orkestrator/review-artifacts/${packageId}/validation-01.stdout.txt`,
    );
  });

  test("reports a validation artifact the preparation agent never wrote", async () => {
    const packageId = "package-missing";
    const { worktreePath, artifactDirectory } = await createReviewPackageWorktree({
      packageId,
    });
    await fs.writeFile(
      path.join(artifactDirectory, "validation-01.stdout.txt"),
      "all tests passed\n",
    );
    const environment = createEnvironment({
      worktreePath,
      branch: "feature/local",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const command = commands.get("generate_looped_review_package")!;
    const args = {
      environmentId: environment.id,
      packageId,
      round: 1,
      targetBranch: "main",
      preparation: {
        validation: [{
          command: "bun test tests --parallel",
          status: "passed",
          exitCode: 0,
          stdoutPath: `.orkestrator/review-artifacts/${packageId}/validation-01.stdout.txt`,
          stderrPath: `.orkestrator/review-artifacts/${packageId}/validation-01.stderr.txt`,
          durationMs: 123,
          limitation: null,
        }],
        uncommittedFiles: [],
        limitations: [],
      },
    };

    // The stderr artifact is missing. Accepting a bare filename means a path can
    // now pass validation and still not exist, so the read has to say so in
    // review terms rather than surfacing a bare ENOENT.
    await expect(command(args, context)).rejects.toThrow(
      `Review artifact was not written by preparation: `
      + `.orkestrator/review-artifacts/${packageId}/validation-01.stderr.txt`,
    );

    const stderrArtifact = path.join(artifactDirectory, "validation-01.stderr.txt");
    await fs.mkdir(stderrArtifact);
    await expect(command(args, context)).rejects.toThrow(
      "Review artifact is not a regular file",
    );
    await fs.rmdir(stderrArtifact);

    const outsideDirectory = await createTempDir("ork-electron-outside-artifact-");
    const outsideFile = path.join(outsideDirectory, "stderr.txt");
    await fs.writeFile(outsideFile, "escaped\n");
    await fs.symlink(outsideFile, stderrArtifact);
    await expect(command(args, context)).rejects.toThrow(
      "Review artifact escapes the environment worktree",
    );
    await fs.unlink(stderrArtifact);

    // Kept inside the artifact directory so it stays out of the uncommitted-file
    // reconciliation this test is not exercising.
    const insideFile = path.join(artifactDirectory, "real-stderr.txt");
    await fs.writeFile(insideFile, "inside\n");
    await fs.symlink(insideFile, stderrArtifact);
    await expect(command(args, context)).rejects.toThrow(
      "Review artifact must not traverse symbolic links",
    );
  });

  test("rejects preparation validation metadata that breaks the evidence contract", async () => {
    const environment = createEnvironment({
      worktreePath: "/tmp/worktree-unused",
      branch: "feature/local",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const command = commands.get("generate_looped_review_package")!;
    const packageId = "package-contract";
    const ran = {
      command: "bun test tests --parallel",
      status: "passed",
      exitCode: 0,
      stdoutPath: `.orkestrator/review-artifacts/${packageId}/validation-01.stdout.txt`,
      stderrPath: `.orkestrator/review-artifacts/${packageId}/validation-01.stderr.txt`,
      durationMs: 123,
      limitation: null,
    };
    const skipped = {
      command: "bun run --cwd apps/ios typecheck",
      status: "skipped",
      exitCode: null,
      stdoutPath: null,
      stderrPath: null,
      durationMs: 0,
      limitation: "Xcode is unavailable in this environment.",
    };
    // Every case below is rejected while parsing the arguments, before any Git
    // command runs, so the worktree above is never touched.
    const call = (validation: unknown) => command({
      environmentId: environment.id,
      packageId,
      round: 1,
      targetBranch: "main",
      preparation: { validation, uncommittedFiles: [], limitations: [] },
    }, context);

    await expect(call({})).rejects.toThrow("Expected validation to be an array");
    await expect(call([null])).rejects.toThrow("Expected validation[0] to be an object");
    await expect(call([{ ...ran, extra: 1 }])).rejects.toThrow(
      "Unexpected validation[0] field: extra",
    );
    await expect(call([{ ...ran, command: "   " }])).rejects.toThrow(
      "Expected validation[0].command to be non-empty",
    );
    await expect(call([{ ...ran, status: "errored" }])).rejects.toThrow(
      "Invalid validation[0].status",
    );
    for (const durationMs of [-1, 1.5, "123", null]) {
      await expect(call([{ ...ran, durationMs }])).rejects.toThrow(
        "Expected validation[0].durationMs to be a non-negative integer",
      );
    }
    for (const limitation of ["", "   ", 7]) {
      await expect(call([{ ...ran, limitation }])).rejects.toThrow(
        "Expected validation[0].limitation to be a non-empty string or null",
      );
    }
    for (const override of [
      { exitCode: 0 },
      { stdoutPath: ran.stdoutPath },
      { stderrPath: ran.stderrPath },
      { limitation: null },
    ]) {
      await expect(call([{ ...skipped, ...override }])).rejects.toThrow(
        "Skipped validation[0] has incompatible evidence metadata",
      );
    }
    for (const exitCode of [null, "0", 1.5]) {
      await expect(call([{ ...ran, exitCode }])).rejects.toThrow(
        "Expected validation[0].exitCode to be an integer",
      );
    }
    await expect(call([{ ...ran, exitCode: 1 }])).rejects.toThrow(
      "Validation[0] status does not match its exit code",
    );
    await expect(call([{ ...ran, status: "failed", exitCode: 0 }])).rejects.toThrow(
      "Validation[0] status does not match its exit code",
    );
    await expect(call([{ ...ran, stderrPath: null }])).rejects.toThrow(
      "Expected validation[0].stderrPath to be a string",
    );
    // The index in the message is the entry's own position, not the first one's.
    await expect(call([skipped, { ...ran, exitCode: 1 }])).rejects.toThrow(
      "Validation[1] status does not match its exit code",
    );
  });

  test("deletes the remote head branch during merged local environment cleanup", async () => {
    const worktreePath = await createTempDir("ork-electron-cleanup-delete-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "merged",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42" ]; then
  printf '%s\\n' '{"head":{"ref":"feature/cleanup","repo":{"full_name":"acme/repo"}}}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/git/refs/heads/feature/cleanup" ] && [ "$3" = "--method" ] && [ "$4" = "DELETE" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`, async (logPath) => {
      await expect(commands.get("delete_environment")?.({ environmentId: environment.id }, context)).resolves.toBeUndefined();

      const ghLog = await fs.readFile(logPath, "utf8");
      expect(ghLog).toContain("api repos/acme/repo/pulls/42");
      expect(ghLog).toContain("api repos/acme/repo/git/refs/heads/feature/cleanup --method DELETE");
      await expect(commands.get("get_environment")?.({ environmentId: environment.id }, context)).resolves.toBeNull();
    });
  });

  test("continues merged environment cleanup when the remote head branch is already deleted", async () => {
    const worktreePath = await createTempDir("ork-electron-cleanup-delete-404-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "merged",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42" ]; then
  printf '%s\\n' '{"head":{"ref":"feature/already-cleaned","repo":{"full_name":"acme/repo"}}}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/git/refs/heads/feature/already-cleaned" ] && [ "$3" = "--method" ] && [ "$4" = "DELETE" ]; then
  printf '%s\\n' 'HTTP 422: Reference does not exist' >&2
  exit 1
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`, async (logPath) => {
      await expect(commands.get("delete_environment")?.({ environmentId: environment.id }, context)).resolves.toBeUndefined();

      const ghLog = await fs.readFile(logPath, "utf8");
      expect(ghLog).toContain("api repos/acme/repo/git/refs/heads/feature/already-cleaned --method DELETE");
      await expect(commands.get("get_environment")?.({ environmentId: environment.id }, context)).resolves.toBeNull();
    });
  });

  test("does not delete remote branches during closed environment cleanup", async () => {
    const worktreePath = await createTempDir("ork-electron-cleanup-closed-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "closed",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
printf 'gh should not be called\\n' >&2
exit 1
`, async (logPath) => {
      await expect(commands.get("delete_environment")?.({ environmentId: environment.id }, context)).resolves.toBeUndefined();

      expect(existsSync(logPath)).toBe(false);
      await expect(commands.get("get_environment")?.({ environmentId: environment.id }, context)).resolves.toBeNull();
    });
  });

  test("deletes the remote head branch during merged running container cleanup", async () => {
    const environment = createEnvironment({
      id: "env-container-cleanup",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "merged",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "exec" ]; then
  printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
  case "$*" in
    *ORKESTRATOR_SETUP_CAPABILITIES*)
      printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
      exit 0
      ;;
    *--prepare-only*)
      printf '\\036ORKESTRATOR_PREPARE_OK\\037'
      exit 0
      ;;
    *pulls/42*)
      printf '%s\\n' '{"head":{"ref":"feature/container-cleanup","repo":{"full_name":"acme/repo"}}}'
      exit 0
      ;;
    *refs/heads/feature/container-cleanup*)
      exit 0
      ;;
  esac
  printf 'unexpected docker exec args: %s\\n' "$*" >&2
  exit 1
fi
if [ "$1" = "rm" ]; then
  printf '%s\\n' "$3" >> "$FAKE_DOCKER_RM_LOG"
  exit 0
fi
exit 0
`, async (logs) => {
      await expect(commands.get("delete_environment")?.({ environmentId: environment.id }, context)).resolves.toBeUndefined();

      const execLog = await fs.readFile(logs.exec, "utf8");
      expect(execLog).toContain("pulls/42");
      expect(execLog).toContain("refs/heads/feature/container-cleanup");
      expect(execLog).toContain("DELETE");
      const rmLog = await fs.readFile(logs.rm, "utf8");
      expect(rmLog).toContain("container-1");
      await expect(commands.get("get_environment")?.({ environmentId: environment.id }, context)).resolves.toBeNull();
    });
  });

  test("removes the environment even when remote branch deletion fails for a non-404 reason", async () => {
    const worktreePath = await createTempDir("ork-electron-cleanup-delete-error-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "merged",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
printf '%s\\n' 'HTTP 500: Internal Server Error' >&2
exit 1
`, async (logPath) => {
      await expect(commands.get("delete_environment")?.({ environmentId: environment.id }, context)).resolves.toBeUndefined();

      const ghLog = await fs.readFile(logPath, "utf8");
      expect(ghLog).toContain("api repos/acme/repo/pulls/42");
      await expect(commands.get("get_environment")?.({ environmentId: environment.id }, context)).resolves.toBeNull();
    });
  });

  test("does not delete remote branches when a merged environment has no PR url", async () => {
    const worktreePath = await createTempDir("ork-electron-cleanup-no-prurl-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: null,
      prState: "merged",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
printf 'gh should not be called\\n' >&2
exit 1
`, async (logPath) => {
      await expect(commands.get("delete_environment")?.({ environmentId: environment.id }, context)).resolves.toBeUndefined();

      expect(existsSync(logPath)).toBe(false);
      await expect(commands.get("get_environment")?.({ environmentId: environment.id }, context)).resolves.toBeNull();
    });
  });

  test("does not delete remote branches when a merged container environment is not running", async () => {
    const environment = createEnvironment({
      id: "env-container-stopped",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: "container-stopped",
      status: "stopped",
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "merged",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "exec" ]; then
  printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
  printf 'docker exec should not be called for a stopped container\\n' >&2
  exit 1
fi
if [ "$1" = "rm" ]; then
  printf '%s\\n' "$3" >> "$FAKE_DOCKER_RM_LOG"
  exit 0
fi
exit 0
`, async (logs) => {
      await expect(commands.get("delete_environment")?.({ environmentId: environment.id }, context)).resolves.toBeUndefined();

      expect(existsSync(logs.exec)).toBe(false);
      const rmLog = await fs.readFile(logs.rm, "utf8");
      expect(rmLog).toContain("container-stopped");
      await expect(commands.get("get_environment")?.({ environmentId: environment.id }, context)).resolves.toBeNull();
    });
  });

  test("waits for a local bridge server to pass health before persisting pid and port", async () => {
    const appRoot = await createTempDir("ork-electron-app-");
    const toolchainBinDir = await createTempDir("ork-electron-toolchain-");
    const worktreePath = await createTempDir("ork-electron-worktree-");
    const markerPath = path.join(appRoot, "codex-path.log");
    const versionMarkerPath = path.join(appRoot, "codex-version.log");
    const maxConcurrentThreadsMarkerPath = path.join(appRoot, "codex-max-threads.log");
    const managedCodexPath = path.join(toolchainBinDir, "codex");
    await fs.writeFile(managedCodexPath, "managed codex");
    await writeBridgeServer(
      appRoot,
      "codex-bridge",
      markerPath,
      undefined,
      versionMarkerPath,
      maxConcurrentThreadsMarkerPath,
    );

    const environment = createEnvironment({ worktreePath });
    const { context, updates } = createContext(environment, {
      globalConfig: { codexMaxConcurrentThreads: 8 },
    });
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    context.toolchainBinDir = toolchainBinDir;

    const commands = createCommandRegistry();
    const result = await commands.get("start_local_codex_server_cmd")?.({ environmentId: environment.id }, context) as {
      port: number;
      pid: number;
      wasRunning: boolean;
      authToken: string;
    };

    expect(result.wasRunning).toBe(false);
    expect(result.port).toBeGreaterThan(0);
    expect(result.pid).toBeGreaterThan(0);
    expect(result.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(updates).toContainEqual({ localCodexPort: result.port, codexBridgePid: result.pid });
    await expect(
      commands.get("get_local_codex_server_status")?.(
        { environmentId: environment.id },
        context,
      ),
    ).resolves.toMatchObject({
      running: true,
      port: result.port,
      pid: result.pid,
      authToken: result.authToken,
    });
    await expect(requestOk(result.port, "/global/health")).resolves.toBe(true);
    expect(await fs.readFile(markerPath, "utf8")).toBe(managedCodexPath);
    expect(await fs.readFile(versionMarkerPath, "utf8")).toBe(APP_VERSION);
    expect(await fs.readFile(maxConcurrentThreadsMarkerPath, "utf8")).toBe("8");

    await commands.get("stop_local_codex_server_cmd")?.({ environmentId: environment.id }, context);
    await expect(
      commands.get("get_local_codex_server_status")?.(
        { environmentId: environment.id },
        context,
      ),
    ).resolves.toEqual({
      running: false,
      port: null,
      pid: null,
    });

    const fallbackEnvironment = createEnvironment({
      id: "env-local-codex-fallback",
      worktreePath,
    });
    const { context: fallbackContext } = createContext(fallbackEnvironment, {
      globalConfig: { codexMaxConcurrentThreads: "invalid" },
    });
    fallbackContext.appRoot = appRoot;
    fallbackContext.resourceRoot = appRoot;
    fallbackContext.toolchainBinDir = toolchainBinDir;
    const fallbackResult = await commands.get("start_local_codex_server_cmd")?.(
      { environmentId: fallbackEnvironment.id },
      fallbackContext,
    ) as { port: number; pid: number; wasRunning: boolean };
    try {
      expect(fallbackResult.wasRunning).toBe(false);
      expect(await fs.readFile(maxConcurrentThreadsMarkerPath, "utf8")).toBe("5");
    } finally {
      await commands.get("stop_local_codex_server_cmd")?.(
        { environmentId: fallbackEnvironment.id },
        fallbackContext,
      );
    }
  });

  test("does not report a child that exits while local status awaits storage as running", async () => {
    const appRoot = await createTempDir("ork-electron-app-status-exit-race-");
    const worktreePath = await createTempDir("ork-electron-worktree-status-exit-race-");
    await writeBridgeServer(appRoot, "codex-bridge");
    const environment = createEnvironment({ worktreePath });
    const { context } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();

    const started = await commands.get("start_local_codex_server_cmd")?.(
      { environmentId: environment.id },
      context,
    ) as { port: number; pid: number };
    const lookupStarted = createDeferred();
    const releaseLookup = createDeferred();
    const getEnvironment = context.storage.getEnvironment.bind(context.storage);
    context.storage.getEnvironment = mock(async (environmentId: string) => {
      lookupStarted.resolve(undefined);
      await releaseLookup.promise;
      return getEnvironment(environmentId);
    });

    const statusPromise = commands.get("get_local_codex_server_status")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<unknown>;
    await lookupStarted.promise;
    try {
      process.kill(started.pid, "SIGTERM");
      await waitForCondition(
        () => commandTesting.getLocalServerProcess(`codex:${environment.id}`) === undefined,
        "exited Codex bridge ownership release",
      );
    } finally {
      releaseLookup.resolve(undefined);
    }

    await expect(statusPromise).resolves.toEqual({
      running: false,
      port: started.port,
      pid: started.pid,
    });
    expect(commandTesting.getLocalCodexBridgeToken(environment.id)).toBeUndefined();
  });

  test("drains a local Codex bridge and its descendants before deleting the environment", async () => {
    const appRoot = await createTempDir("ork-electron-app-delete-codex-");
    const worktreePath = await createTempDir("ork-electron-worktree-delete-codex-");
    const pidMarkerPath = path.join(appRoot, "codex-processes.json");
    const shutdownMarkerPath = path.join(appRoot, "codex-shutdown.txt");
    await writeBridgeEntrypoint(
      appRoot,
      "codex-bridge",
      `
        const fs = require("node:fs");
        const http = require("node:http");
        const { spawn } = require("node:child_process");
        const descendant = spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 1_000)"],
          { stdio: "ignore" },
        );
        fs.writeFileSync(
          ${JSON.stringify(pidMarkerPath)},
          JSON.stringify({ bridgePid: process.pid, descendantPid: descendant.pid }),
        );
        const server = http.createServer((req, res) => {
          if (req.url === "/global/health") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.writeHead(404);
          res.end();
        });
        server.listen(Number(process.env.PORT), "127.0.0.1");
        process.on("SIGTERM", () => {
          fs.writeFileSync(
            ${JSON.stringify(shutdownMarkerPath)},
            String(fs.existsSync(process.env.CWD)),
          );
          server.close(() => process.exit(0));
        });
      `,
    );

    const environment = createEnvironment({ worktreePath });
    const { context } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();
    const started = await commands.get("start_local_codex_server_cmd")?.(
      { environmentId: environment.id },
      context,
    ) as { port: number; pid: number };
    await waitForCondition(() => existsSync(pidMarkerPath), "Codex process marker");
    const processes = JSON.parse(await fs.readFile(pidMarkerPath, "utf8")) as {
      bridgePid: number;
      descendantPid: number;
    };

    expect(processes.bridgePid).toBe(started.pid);
    expect(isProcessRunning(processes.bridgePid)).toBe(true);
    expect(isProcessRunning(processes.descendantPid)).toBe(true);

    await commands.get("delete_environment")?.(
      { environmentId: environment.id },
      context,
    );

    expect(await fs.readFile(shutdownMarkerPath, "utf8")).toBe("true");
    expect(isProcessRunning(processes.bridgePid)).toBe(false);
    await waitForCondition(
      () => !isProcessRunning(processes.descendantPid),
      "Codex descendant to exit",
    );
    await expect(
      commands.get("get_environment")?.(
        { environmentId: environment.id },
        context,
      ),
    ).resolves.toBeNull();
  }, ASYNC_TEST_BUDGET_MS);

  test("serializes simultaneous starts so one local server owns the key", async () => {
    const appRoot = await createTempDir("ork-electron-app-concurrent-start-");
    const worktreePath = await createTempDir("ork-electron-worktree-concurrent-start-");
    await writeBridgeServer(appRoot, "codex-bridge");
    const environment = createEnvironment({ worktreePath });
    const { context } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();

    const [first, second] = await Promise.all([
      commands.get("start_local_codex_server_cmd")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<{ port: number; pid: number; wasRunning: boolean }>,
      commands.get("start_local_codex_server_cmd")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<{ port: number; pid: number; wasRunning: boolean }>,
    ]);

    try {
      expect(first.pid).toBe(second.pid);
      expect(first.port).toBe(second.port);
      expect([first.wasRunning, second.wasRunning].sort()).toEqual([false, true]);
      expect(isProcessRunning(first.pid)).toBe(true);
    } finally {
      await commands.get("stop_local_codex_server_cmd")?.(
        { environmentId: environment.id },
        context,
      );
    }
  });

  test("holds local server status behind an in-flight startup until its ready port is committed", async () => {
    const appRoot = await createTempDir("ork-electron-app-start-status-");
    const worktreePath = await createTempDir("ork-electron-worktree-start-status-");
    await writeBridgeServer(appRoot, "codex-bridge");
    const environment = createEnvironment({ worktreePath });
    const { context } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commitStarted = createDeferred();
    const releaseCommit = createDeferred();
    const updateEnvironment = context.storage.updateEnvironment.bind(context.storage);
    context.storage.updateEnvironment = mock(async (
      environmentId: string,
      update: Record<string, unknown>,
    ) => {
      if (typeof update.localCodexPort === "number") {
        commitStarted.resolve(undefined);
        await releaseCommit.promise;
      }
      return updateEnvironment(environmentId, update);
    });
    const commands = createCommandRegistry();

    const startPromise = commands.get("start_local_codex_server_cmd")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<{ port: number; pid: number; authToken: string }>;
    await commitStarted.promise;

    let statusReadStarted = false;
    const getEnvironment = context.storage.getEnvironment.bind(context.storage);
    context.storage.getEnvironment = mock(async (environmentId: string) => {
      statusReadStarted = true;
      return getEnvironment(environmentId);
    });

    const statusPromise = commands.get("get_local_codex_server_status")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<{
      running: boolean;
      port: number | null;
      pid: number | null;
      authToken?: string;
    }>;
    try {
      expect(statusReadStarted).toBe(false);
    } finally {
      releaseCommit.resolve(undefined);
    }
    const [started, status] = await Promise.all([startPromise, statusPromise]);
    try {
      expect(status).toEqual({
        running: true,
        port: started.port,
        pid: started.pid,
        authToken: started.authToken,
      });
    } finally {
      await commands.get("stop_local_codex_server_cmd")?.(
        { environmentId: environment.id },
        context,
      );
    }
  }, ASYNC_TEST_BUDGET_MS);

  test("runs queued status after a rejected startup and reports the cleaned stopped state", async () => {
    const appRoot = await createTempDir("ork-electron-app-rejected-start-status-");
    const worktreePath = await createTempDir("ork-electron-worktree-rejected-start-status-");
    await writeBridgeEntrypoint(
      appRoot,
      "codex-bridge",
      "process.exitCode = 23;",
    );
    const environment = createEnvironment({
      worktreePath,
      localCodexPort: 40123,
      codexBridgePid: 50123,
    });
    const { context } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();

    const startPromise = commands.get("start_local_codex_server_cmd")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<unknown>;
    const statusPromise = commands.get("get_local_codex_server_status")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<unknown>;

    const [startResult, statusResult] = await Promise.allSettled([
      startPromise,
      statusPromise,
    ]);
    expect(startResult.status).toBe("rejected");
    if (startResult.status === "rejected") {
      expect(startResult.reason).toBeInstanceOf(Error);
      expect((startResult.reason as Error).message).toContain(
        "codex server exited before becoming healthy",
      );
    }
    expect(statusResult).toEqual({
      status: "fulfilled",
      value: {
        running: false,
        port: null,
        pid: null,
      },
    });
    expect(commandTesting.getLocalServerProcess(`codex:${environment.id}`)).toBeUndefined();
    expect(commandTesting.getLocalCodexBridgeToken(environment.id)).toBeUndefined();
  }, ASYNC_TEST_BUDGET_MS);

  test("holds status behind an in-flight stop until process ownership and metadata are cleared", async () => {
    const environment = createEnvironment({
      id: "env-status-behind-stop",
      localCodexPort: 40124,
      codexBridgePid: 50124,
    });
    const { context } = createContext(environment);
    const child = createFakeChild(50124);
    commandTesting.setLocalServerProcess(`codex:${environment.id}`, child);
    const terminationStarted = createDeferred();
    const releaseTermination = createDeferred();
    commandTesting.setTerminateProcessTree(async () => {
      terminationStarted.resolve(undefined);
      await releaseTermination.promise;
      return true;
    });
    const commands = createCommandRegistry();

    const stopPromise = commands.get("stop_local_codex_server_cmd")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<void>;
    await terminationStarted.promise;

    let statusReadStarted = false;
    const getEnvironment = context.storage.getEnvironment.bind(context.storage);
    context.storage.getEnvironment = mock(async (environmentId: string) => {
      statusReadStarted = true;
      return getEnvironment(environmentId);
    });
    const statusPromise = commands.get("get_local_codex_server_status")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<unknown>;
    try {
      expect(statusReadStarted).toBe(false);
    } finally {
      releaseTermination.resolve(undefined);
    }
    await expect(Promise.all([stopPromise, statusPromise])).resolves.toEqual([
      undefined,
      { running: false, port: null, pid: null },
    ]);
  });

  test("serializes status across local server kinds for the same environment", async () => {
    const environment = createEnvironment({
      id: "env-cross-kind-status-order",
      localCodexPort: 40125,
      codexBridgePid: 50125,
      localClaudePort: 40126,
      claudeBridgePid: 50126,
    });
    const { context } = createContext(environment);
    const child = createFakeChild(50125);
    commandTesting.setLocalServerProcess(`codex:${environment.id}`, child);
    const terminationStarted = createDeferred();
    const releaseTermination = createDeferred();
    commandTesting.setTerminateProcessTree(async () => {
      terminationStarted.resolve(undefined);
      await releaseTermination.promise;
      return true;
    });
    const commands = createCommandRegistry();

    const stopPromise = commands.get("stop_local_codex_server_cmd")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<void>;
    await terminationStarted.promise;

    let claudeStatusReadStarted = false;
    const getEnvironment = context.storage.getEnvironment.bind(context.storage);
    context.storage.getEnvironment = mock(async (environmentId: string) => {
      claudeStatusReadStarted = true;
      return getEnvironment(environmentId);
    });
    const claudeStatusPromise = commands.get("get_local_claude_server_status")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<unknown>;
    try {
      expect(claudeStatusReadStarted).toBe(false);
    } finally {
      releaseTermination.resolve(undefined);
    }
    await expect(Promise.all([stopPromise, claudeStatusPromise])).resolves.toEqual([
      undefined,
      { running: false, port: 40126, pid: 50126 },
    ]);
  });

  test("serializes a stop queued behind startup and leaves metadata cleared", async () => {
    const appRoot = await createTempDir("ork-electron-app-start-stop-");
    const worktreePath = await createTempDir("ork-electron-worktree-start-stop-");
    await writeBridgeServer(appRoot, "codex-bridge");
    const environment = createEnvironment({ worktreePath });
    const { context } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();

    const startPromise = commands.get("start_local_codex_server_cmd")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<{ port: number; pid: number }>;
    const stopPromise = commands.get("stop_local_codex_server_cmd")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<void>;

    const started = await startPromise;
    await stopPromise;

    expect(isProcessRunning(started.pid)).toBe(false);
    expect(environment.localCodexPort).toBeNull();
    expect(environment.codexBridgePid).toBeNull();
  });

  test("drains a start already in flight and rejects later starts once deletion begins", async () => {
    const appRoot = await createTempDir("ork-electron-app-start-delete-");
    const worktreePath = await createTempDir("ork-electron-worktree-start-delete-");
    const startedMarkerPath = path.join(appRoot, "bridge-started.txt");
    await writeBridgeEntrypoint(
      appRoot,
      "codex-bridge",
      `
        const fs = require("node:fs");
        const http = require("node:http");
        fs.writeFileSync(${JSON.stringify(startedMarkerPath)}, "started");
        setTimeout(() => {
          http.createServer((req, res) => {
            res.writeHead(req.url === "/global/health" ? 200 : 404);
            res.end();
          }).listen(Number(process.env.PORT), "127.0.0.1");
        }, 100);
      `,
    );
    const environment = createEnvironment({ worktreePath });
    const { context } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();

    const startPromise = commands.get("start_local_codex_server_cmd")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<{ pid: number }>;
    await waitForCondition(() => existsSync(startedMarkerPath), "in-flight bridge startup");
    const deletePromise = commands.get("delete_environment")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<void>;

    await expect(commands.get("delete_environment")?.(
      { environmentId: environment.id },
      context,
    )).rejects.toThrow("Environment is already being deleted");
    expect(() => commands.get("start_local_codex_server_cmd")?.(
      { environmentId: environment.id },
      context,
    )).toThrow("Environment is being deleted");

    const started = await startPromise;
    await deletePromise;
    expect(isProcessRunning(started.pid)).toBe(false);
    await expect(
      commands.get("get_environment")?.(
        { environmentId: environment.id },
        context,
      ),
    ).resolves.toBeNull();
  }, ASYNC_TEST_BUDGET_MS);

  test("persists deletion intent before closing active terminals and rejects raced terminal operations", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-delete-race-");
    const environment = createEnvironment({
      id: "env-terminal-delete-race",
      environmentType: "containerized",
      containerId: "container-terminal-delete-race",
      worktreePath,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const local = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      {
        environmentId: environment.id,
        terminalKey: "local-tab",
        cols: 80,
        rows: 24,
      },
      context,
    ));
    const container = terminalSessionResult(await commands.get("create_terminal_session")?.(
      {
        containerId: environment.containerId,
        environmentId: environment.id,
        terminalKey: "container-tab",
        cols: 80,
        rows: 24,
      },
      context,
    ));
    await commands.get("start_local_terminal_session")?.(
      { sessionId: local.sessionId },
      context,
    );
    await commands.get("start_terminal_session")?.(
      { sessionId: container.sessionId },
      context,
    );

    const originalUpdateEnvironment = context.storage.updateEnvironment.bind(context.storage);
    let releaseDeletionMarker!: () => void;
    const deletionMarkerGate = new Promise<void>((resolve) => {
      releaseDeletionMarker = resolve;
    });
    let markerWriteStarted = false;
    context.storage.updateEnvironment = mock(async (environmentId, update) => {
      if ("deletionRequestedAt" in update) {
        markerWriteStarted = true;
        await deletionMarkerGate;
      }
      return originalUpdateEnvironment(environmentId, update);
    });

    const deletePromise = commands.get("delete_environment")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<void>;
    await waitForCondition(() => markerWriteStarted, "the deletion marker write");

    // Destructive cleanup waits for the durable marker.
    expect(ptyProcesses[0]?.kill).not.toHaveBeenCalled();
    expect(ptyProcesses[1]?.kill).not.toHaveBeenCalled();
    await expect(commands.get("create_local_terminal_session")?.(
      {
        environmentId: environment.id,
        terminalKey: "raced-local-tab",
        cols: 80,
        rows: 24,
      },
      context,
    )).rejects.toThrow("Environment is being deleted");
    await expect(commands.get("create_terminal_session")?.(
      {
        containerId: environment.containerId,
        environmentId: environment.id,
        terminalKey: "raced-container-tab",
        cols: 80,
        rows: 24,
      },
      context,
    )).rejects.toThrow("Environment is being deleted");
    await expect(commands.get("start_local_terminal_session")?.(
      { sessionId: local.sessionId },
      context,
    )).rejects.toThrow("Environment is being deleted");
    await expect(commands.get("start_terminal_session")?.(
      { sessionId: container.sessionId },
      context,
    )).rejects.toThrow("Environment is being deleted");

    releaseDeletionMarker();
    await deletePromise;
    expect(ptyProcesses[0]?.kill).toHaveBeenCalledTimes(1);
    expect(ptyProcesses[1]?.kill).toHaveBeenCalledTimes(1);
    expect(commands.get("get_terminal_output_snapshot")?.(
      { sessionId: local.sessionId },
      context,
    )).toEqual({ output: "", revision: 0, generation: 0, truncated: false });
    expect(commands.get("get_terminal_output_snapshot")?.(
      { sessionId: container.sessionId },
      context,
    )).toEqual({ output: "", revision: 0, generation: 0, truncated: false });
  }, ASYNC_TEST_BUDGET_MS);

  test("leaves active terminals intact when persisting deletion intent fails", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-delete-marker-failure-");
    const environment = createEnvironment({
      id: "env-terminal-delete-marker-failure",
      worktreePath,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const session = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      {
        environmentId: environment.id,
        terminalKey: "surviving-tab",
        cols: 80,
        rows: 24,
      },
      context,
    ));
    await commands.get("start_local_terminal_session")?.(
      { sessionId: session.sessionId },
      context,
    );
    const originalUpdateEnvironment = context.storage.updateEnvironment.bind(context.storage);
    context.storage.updateEnvironment = mock(async (environmentId, update) => {
      if ("deletionRequestedAt" in update) {
        throw new Error("deletion marker storage unavailable");
      }
      return originalUpdateEnvironment(environmentId, update);
    });

    await expect(commands.get("delete_environment")?.(
      { environmentId: environment.id },
      context,
    )).rejects.toThrow("deletion marker storage unavailable");

    expect(ptyProcesses[0]?.kill).not.toHaveBeenCalled();
    expect(commands.get("get_terminal_session")?.(
      { sessionId: session.sessionId },
      context,
    )).toEqual({ id: session.sessionId, running: true });
    await expect(commands.get("get_environment")?.(
      { environmentId: environment.id },
      context,
    )).resolves.toBe(environment);
    commands.get("close_local_terminal_session")?.(
      { sessionId: session.sessionId },
      context,
    );
  });

  test("rejects terminal create and start after deletion intent persists but deletion fails", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-durable-delete-marker-");
    const environment = createEnvironment({
      id: "env-terminal-durable-delete-marker",
      environmentType: "containerized",
      containerId: "container-durable-delete-marker",
      worktreePath,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const local = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      {
        environmentId: environment.id,
        terminalKey: "local-before-delete",
        cols: 80,
        rows: 24,
      },
      context,
    ));
    const container = terminalSessionResult(await commands.get("create_terminal_session")?.(
      {
        containerId: environment.containerId,
        environmentId: environment.id,
        terminalKey: "container-before-delete",
        cols: 80,
        rows: 24,
      },
      context,
    ));
    const originalUpdateEnvironment = context.storage.updateEnvironment.bind(context.storage);
    context.storage.updateEnvironment = mock(async (environmentId, update) => {
      const updated = await originalUpdateEnvironment(environmentId, update);
      if ("deletionRequestedAt" in update) {
        // Model an acknowledged durable write whose caller subsequently sees a
        // transport/storage failure. The in-memory tombstone is cleared, but the
        // stored deletion intent must continue blocking terminal operations.
        throw new Error("deletion failed after marker persistence");
      }
      return updated;
    });

    await expect(commands.get("delete_environment")?.(
      { environmentId: environment.id },
      context,
    )).rejects.toThrow("deletion failed after marker persistence");
    expect(environment.deletionRequestedAt).toBeString();

    await expect(commands.get("create_local_terminal_session")?.(
      {
        environmentId: environment.id,
        terminalKey: "local-after-delete",
        cols: 80,
        rows: 24,
      },
      context,
    )).rejects.toThrow("Environment is being deleted");
    await expect(commands.get("create_terminal_session")?.(
      {
        containerId: environment.containerId,
        environmentId: environment.id,
        terminalKey: "container-after-delete",
        cols: 80,
        rows: 24,
      },
      context,
    )).rejects.toThrow("Environment is being deleted");
    await expect(commands.get("start_local_terminal_session")?.(
      { sessionId: local.sessionId },
      context,
    )).rejects.toThrow("Environment is being deleted");
    await expect(commands.get("start_terminal_session")?.(
      { sessionId: container.sessionId },
      context,
    )).rejects.toThrow("Environment is being deleted");
    expect(ptySpawn).not.toHaveBeenCalled();

    commands.get("close_local_terminal_session")?.(
      { sessionId: local.sessionId },
      context,
    );
    commands.get("detach_terminal")?.(
      { sessionId: container.sessionId },
      context,
    );
  });

  test("does not spawn a local PTY after its environment is deleted during lookup", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-start-delete-race-");
    const environment = createEnvironment({
      id: "env-terminal-start-delete-race",
      worktreePath,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const session = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      {
        environmentId: environment.id,
        terminalKey: "pending-tab",
        cols: 80,
        rows: 24,
      },
      context,
    ));
    const originalGetEnvironment = context.storage.getEnvironment.bind(context.storage);
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    let firstLookupStarted = false;
    context.storage.getEnvironment = mock(async (environmentId) => {
      if (!firstLookupStarted) {
        firstLookupStarted = true;
        await lookupGate;
        return environment;
      }
      return originalGetEnvironment(environmentId);
    });

    const startPromise = commands.get("start_local_terminal_session")?.(
      { sessionId: session.sessionId },
      context,
    ) as Promise<void>;
    await waitForCondition(() => firstLookupStarted, "the terminal environment lookup");
    await commands.get("delete_environment")?.(
      { environmentId: environment.id },
      context,
    );
    // Recreate the path to prove the final storage revalidation, not merely the
    // filesystem-existence check, prevents the stale start.
    await fs.mkdir(worktreePath, { recursive: true });
    releaseLookup();

    await expect(startPromise).rejects.toThrow("Environment is being deleted");
    expect(ptySpawn).not.toHaveBeenCalled();
  }, ASYNC_TEST_BUDGET_MS);

  test("waits for an in-flight start before global shutdown and rejects future starts", async () => {
    const appRoot = await createTempDir("ork-electron-app-start-shutdown-");
    const worktreePath = await createTempDir("ork-electron-worktree-start-shutdown-");
    const startedMarkerPath = path.join(appRoot, "bridge-started.txt");
    await writeBridgeEntrypoint(
      appRoot,
      "codex-bridge",
      `
        const fs = require("node:fs");
        const http = require("node:http");
        fs.writeFileSync(${JSON.stringify(startedMarkerPath)}, "started");
        setTimeout(() => {
          http.createServer((req, res) => {
            res.writeHead(req.url === "/global/health" ? 200 : 404);
            res.end();
          }).listen(Number(process.env.PORT), "127.0.0.1");
        }, 100);
      `,
    );
    const environment = createEnvironment({ worktreePath });
    const { context } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();

    const startPromise = commands.get("start_local_codex_server_cmd")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<{ pid: number }>;
    const queuedStartPromise = commands.get("start_local_codex_server_cmd")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<{ pid: number }>;
    await waitForCondition(() => existsSync(startedMarkerPath), "bridge startup before shutdown");
    const shutdownPromise = shutdownLocalServers();
    const started = await startPromise;
    await expect(queuedStartPromise).rejects.toThrow("Backend is shutting down");
    await shutdownPromise;

    expect(isProcessRunning(started.pid)).toBe(false);
    expect(() => commands.get("start_local_codex_server_cmd")?.(
      { environmentId: environment.id },
      context,
    )).toThrow("Backend is shutting down");
    await expect(commands.get("delete_environment")?.(
      { environmentId: environment.id },
      context,
    )).rejects.toThrow("Backend is shutting down");
  }, ASYNC_TEST_BUDGET_MS);

  test("does not spawn an in-flight local server after the bounded shutdown drain expires", async () => {
    const worktreePath = await createTempDir(
      "ork-electron-local-start-shutdown-deadline-",
    );
    const environment = createEnvironment({ worktreePath });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const originalGetEnvironment =
      context.storage.getEnvironment.bind(context.storage);
    let releaseLookup!: () => void;
    let markLookupStarted!: () => void;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    let blocked = false;
    context.storage.getEnvironment = mock(async (environmentId) => {
      if (!blocked) {
        blocked = true;
        markLookupStarted();
        await lookupGate;
      }
      return originalGetEnvironment(environmentId);
    });
    const spawnAttempt = mock(() => {
      throw new Error("local server spawned after shutdown");
    });
    commandTesting.setSpawnLocalServerCommand(
      spawnAttempt as unknown as typeof spawnCommand,
    );

    const start = commands.get("start_local_opencode_server_cmd")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<unknown>;
    await lookupStarted;

    await expect(
      shutdownLocalServers({ operationDrainTimeoutMs: 10 }),
    ).resolves.toBeUndefined();
    releaseLookup();

    await expect(start).rejects.toThrow(
      "Backend is shutting down; local servers cannot be started",
    );
    expect(spawnAttempt).not.toHaveBeenCalled();
  });

  test("deletes an environment only after all three local server kinds exit", async () => {
    const appRoot = await createTempDir("ork-electron-app-delete-all-servers-");
    const toolchainBinDir = await createTempDir("ork-electron-tools-delete-all-servers-");
    const worktreePath = await createTempDir("ork-electron-worktree-delete-all-servers-");
    await writeBridgeServer(appRoot, "claude-bridge");
    await writeBridgeServer(appRoot, "codex-bridge");
    const opencodePath = path.join(toolchainBinDir, "opencode");
    await fs.writeFile(
      opencodePath,
      `#!/bin/sh
PORT=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--port" ]; then shift; PORT="$1"; fi
  shift
done
exec node -e 'const http=require("node:http");http.createServer((req,res)=>{res.writeHead(req.url==="/global/health"?200:404);res.end();}).listen(Number(process.env.PORT_ARG),"127.0.0.1");' \
  </dev/null
`,
    );
    // The wrapper receives the port as argv, so preserve it for the Node server.
    await fs.writeFile(
      opencodePath,
      (await fs.readFile(opencodePath, "utf8")).replace(
        "exec node",
        "export PORT_ARG=\"$PORT\"\nexec node",
      ),
    );
    await fs.chmod(opencodePath, 0o755);

    const environment = createEnvironment({ worktreePath });
    const { context } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    context.toolchainBinDir = toolchainBinDir;
    const commands = createCommandRegistry();

    const started = await Promise.all([
      commands.get("start_local_opencode_server_cmd")?.(
        { environmentId: environment.id },
        context,
      ),
      commands.get("start_local_claude_server_cmd")?.(
        { environmentId: environment.id },
        context,
      ),
      commands.get("start_local_codex_server_cmd")?.(
        { environmentId: environment.id },
        context,
      ),
    ]) as Array<{ pid: number }>;

    await commands.get("delete_environment")?.(
      { environmentId: environment.id },
      context,
    );

    expect(started).toHaveLength(3);
    for (const server of started) expect(isProcessRunning(server.pid)).toBe(false);
    await expect(
      commands.get("get_environment")?.(
        { environmentId: environment.id },
        context,
      ),
    ).resolves.toBeNull();
  });

  test("reports and stops every local server kind through its public handlers", async () => {
    const environment = createEnvironment({
      id: "env-all-local-server-handlers",
      localOpencodePort: 40101,
      opencodePid: 94001,
      localClaudePort: 40102,
      claudeBridgePid: 94002,
      localCodexPort: 40103,
      codexBridgePid: 94003,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const children = {
      opencode: createFakeChild(94001),
      claude: createFakeChild(94002),
      codex: createFakeChild(94003),
    };
    for (const [kind, child] of Object.entries(children)) {
      commandTesting.setLocalServerProcess(`${kind}:${environment.id}`, child);
    }
    commandTesting.setTerminateProcessTree(async () => true);

    await expect(Promise.all([
      commands.get("get_local_opencode_server_status")?.(
        { environmentId: environment.id },
        context,
      ),
      commands.get("get_local_claude_server_status")?.(
        { environmentId: environment.id },
        context,
      ),
      commands.get("get_local_codex_server_status")?.(
        { environmentId: environment.id },
        context,
      ),
    ])).resolves.toEqual([
      { running: true, port: 40101, pid: 94001 },
      { running: true, port: 40102, pid: 94002 },
      { running: true, port: 40103, pid: 94003 },
    ]);

    await expect(Promise.all([
      commands.get("stop_local_opencode_server_cmd")?.(
        { environmentId: environment.id },
        context,
      ),
      commands.get("stop_local_claude_server_cmd")?.(
        { environmentId: environment.id },
        context,
      ),
      commands.get("stop_local_codex_server_cmd")?.(
        { environmentId: environment.id },
        context,
      ),
    ])).resolves.toEqual([undefined, undefined, undefined]);

    expect(environment).toMatchObject({
      localOpencodePort: null,
      opencodePid: null,
      localClaudePort: null,
      claudeBridgePid: null,
      localCodexPort: null,
      codexBridgePid: null,
    });
    for (const kind of Object.keys(children)) {
      expect(commandTesting.getLocalServerProcess(`${kind}:${environment.id}`)).toBeUndefined();
    }
  });

  test("waits for every shutdown attempt, reports failures, and supports retry", async () => {
    const failedChild = createFakeChild(91001);
    const successfulChild = createFakeChild(91002);
    commandTesting.setLocalServerProcess("codex:env-failure", failedChild);
    commandTesting.setLocalServerProcess("claude:env-success", successfulChild);
    const attempted: number[] = [];
    commandTesting.setTerminateProcessTree(async (child) => {
      attempted.push(child.pid ?? 0);
      return child !== failedChild;
    });

    await expect(shutdownLocalServers()).rejects.toThrow(
      "Failed to shut down all local servers",
    );
    expect(attempted.sort()).toEqual([91001, 91002]);
    expect(commandTesting.getLocalServerProcess("codex:env-failure")).toBe(failedChild);
    expect(commandTesting.getLocalServerProcess("claude:env-success")).toBeUndefined();

    commandTesting.setTerminateProcessTree(async () => true);
    await expect(shutdownLocalServers()).resolves.toBeUndefined();
    expect(commandTesting.getLocalServerProcess("codex:env-failure")).toBeUndefined();
  });

  test("retains the environment and process ownership when deletion cannot reap a server", async () => {
    const worktreePath = await createTempDir("ork-electron-delete-failure-");
    const environment = createEnvironment({ id: "env-delete-failure", worktreePath });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const child = createFakeChild(92001);
    commandTesting.setLocalServerProcess(`codex:${environment.id}`, child);
    commandTesting.setTerminateProcessTree(async () => false);

    await expect(commands.get("delete_environment")?.(
      { environmentId: environment.id },
      context,
    )).rejects.toThrow("Failed to stop all local servers");
    expect(await context.storage.getEnvironment(environment.id)).toBe(environment);
    expect(existsSync(worktreePath)).toBe(true);
    expect(commandTesting.getLocalServerProcess(`codex:${environment.id}`)).toBe(child);

    commandTesting.setTerminateProcessTree(async () => true);
    await expect(commands.get("delete_environment")?.(
      { environmentId: environment.id },
      context,
    )).resolves.toBeUndefined();
  });

  test("does not let a stale child release replacement ownership", () => {
    const stale = createFakeChild(93001);
    const replacement = createFakeChild(93002);
    commandTesting.setLocalServerProcess("codex:env-owner", replacement);

    commandTesting.releaseLocalServerOwnership("codex:env-owner", stale);
    expect(commandTesting.getLocalServerProcess("codex:env-owner")).toBe(replacement);

    commandTesting.releaseLocalServerOwnership("codex:env-owner", replacement);
    expect(commandTesting.getLocalServerProcess("codex:env-owner")).toBeUndefined();
  });

  test("launches the local claude bridge through the bundled bun binary in resources", async () => {
    // The bridges run on bun, not node. resolveBunBinary prefers the bun shipped
    // in app resources (resourceRoot/bin/bun) over a host PATH lookup; this proves
    // that preferred binary is the one actually spawned, and that bun can run the
    // bridge entrypoint end-to-end (health passes).
    const appRoot = await createTempDir("ork-electron-app-bun-");
    const resourceRoot = await createTempDir("ork-electron-res-bun-");
    const worktreePath = await createTempDir("ork-electron-worktree-bun-");
    await writeBridgeServer(appRoot, "claude-bridge");

    const markerPath = path.join(resourceRoot, "bun-was-used.log");
    const bunWrapperDir = path.join(resourceRoot, "bin");
    await fs.mkdir(bunWrapperDir, { recursive: true });
    // Wrapper records that it ran, then delegates to the real bun on PATH.
    await fs.writeFile(
      path.join(bunWrapperDir, "bun"),
      `#!/bin/sh\nprintf 'used\\n' >> "${markerPath}"\nexec bun "$@"\n`,
    );
    await fs.chmod(path.join(bunWrapperDir, "bun"), 0o755);

    const environment = createEnvironment({ worktreePath });
    const { context, updates } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = resourceRoot;

    const commands = createCommandRegistry();
    const result = await commands.get("start_local_claude_server_cmd")?.({ environmentId: environment.id }, context) as {
      port: number;
      pid: number;
      wasRunning: boolean;
      authToken: string;
    };

    try {
      expect(result.wasRunning).toBe(false);
      expect(result.port).toBeGreaterThan(0);
      expect(result.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      await expect(requestOk(result.port, "/global/health")).resolves.toBe(true);
      expect(await fs.readFile(markerPath, "utf8")).toContain("used");
      expect(updates).toContainEqual({ localClaudePort: result.port, claudeBridgePid: result.pid });
      await expect(
        commands.get("get_local_claude_server_status")?.(
          { environmentId: environment.id },
          context,
        ),
      ).resolves.toMatchObject({
        running: true,
        port: result.port,
        pid: result.pid,
        authToken: result.authToken,
      });
    } finally {
      await commands.get("stop_local_claude_server_cmd")?.({ environmentId: environment.id }, context);
    }
  });

  test("peeks a local bridge without ever starting one", async () => {
    // The activity sweep polls every environment every two seconds. Resolving
    // its connection through `start_local_*_server_cmd` would spawn a bridge
    // for every environment that has ever held a session — at startup, with no
    // tab open — and then keep them all alive. Peeking must therefore report a
    // bridge that is already running and never create one.
    const appRoot = await createTempDir("ork-electron-app-peek-local-");
    const worktreePath = await createTempDir("ork-electron-worktree-peek-local-");
    await writeBridgeServer(appRoot, "claude-bridge");

    const environment = createEnvironment({ id: "env-peek-local", worktreePath });
    const { context } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();

    // Nothing running yet: null, and no process spawned as a side effect.
    const spawnAttempt = mock(() => {
      throw new Error("peek must not spawn a bridge");
    });
    commandTesting.setSpawnLocalServerCommand(
      spawnAttempt as unknown as typeof spawnCommand,
    );
    await expect(commands.get("peek_local_agent_bridge")?.(
      { environmentId: environment.id, agent: "claude" },
      context,
    )).resolves.toBeNull();
    expect(spawnAttempt).not.toHaveBeenCalled();
    commandTesting.setSpawnLocalServerCommand(spawnCommand);

    const started = await commands.get("start_local_claude_server_cmd")?.(
      { environmentId: environment.id },
      context,
    ) as { port: number; authToken: string };
    try {
      await expect(commands.get("peek_local_agent_bridge")?.(
        { environmentId: environment.id, agent: "claude" },
        context,
      )).resolves.toEqual({
        port: started.port,
        authToken: started.authToken,
      });

      // A different agent shares the environment but has no bridge of its own.
      await expect(commands.get("peek_local_agent_bridge")?.(
        { environmentId: environment.id, agent: "codex" },
        context,
      )).resolves.toBeNull();
    } finally {
      await commands.get("stop_local_claude_server_cmd")?.(
        { environmentId: environment.id },
        context,
      );
    }

    // Once stopped it reports null again rather than resurrecting the bridge.
    await expect(commands.get("peek_local_agent_bridge")?.(
      { environmentId: environment.id, agent: "claude" },
      context,
    )).resolves.toBeNull();
  });

  test("rejects an unknown agent on either peek surface", async () => {
    const environment = createEnvironment({ id: "env-peek-validation" });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    // Validation runs before the handler returns a promise, so these throw
    // synchronously; `invoke` awaits the handler and surfaces them either way.
    expect(() => commands.get("peek_local_agent_bridge")?.(
      { environmentId: environment.id, agent: "gemini" },
      context,
    )).toThrow("agent must be one of: opencode, claude, codex");
    expect(() => commands.get("peek_container_agent_bridge")?.(
      { containerId: "container-1", agent: "gemini" },
      context,
    )).toThrow("agent must be one of: opencode, claude, codex");
    expect(() => commands.get("peek_local_agent_bridge")?.(
      { environmentId: "  ", agent: "claude" },
      context,
    )).toThrow();
    expect(() => commands.get("peek_container_agent_bridge")?.(
      { containerId: "container-1", agent: "claude", extra: 1 },
      context,
    )).toThrow();
  });

  test("restarts a healthy local Claude bridge whose auth token this process no longer holds", async () => {
    const appRoot = await createTempDir("ork-electron-app-tokenless-claude-");
    const worktreePath = await createTempDir("ork-electron-worktree-tokenless-claude-");
    await writeBridgeServer(appRoot, "claude-bridge");

    const environment = createEnvironment({ id: "env-local-tokenless-claude", worktreePath });
    const { context } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();

    const first = await commands.get("start_local_claude_server_cmd")?.(
      { environmentId: environment.id },
      context,
    ) as { port: number; pid: number; authToken: string };
    expect(first.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // A bridge inherited from a previous backend process: still healthy, but its
    // token was never handed to us, so the renderer could not authenticate.
    commandTesting.deleteLocalClaudeBridgeToken(environment.id);

    const second = await commands.get("start_local_claude_server_cmd")?.(
      { environmentId: environment.id },
      context,
    ) as { port: number; pid: number; wasRunning: boolean; authToken: string };
    try {
      expect(second.wasRunning).toBe(false);
      expect(second.pid).not.toBe(first.pid);
      expect(second.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(second.authToken).not.toBe(first.authToken);
      expect(isProcessRunning(first.pid)).toBe(false);
      await expect(requestOk(second.port, "/global/health")).resolves.toBe(true);
    } finally {
      await commands.get("stop_local_claude_server_cmd")?.(
        { environmentId: environment.id },
        context,
      );
    }
  });

  test("discovers and persists the Claude model catalog from the managed local runtime", async () => {
    const appRoot = await createTempDir("ork-electron-app-claude-models-");
    const toolchainBinDir = await createTempDir("ork-electron-tools-claude-models-");
    const worktreePath = await createTempDir("ork-electron-worktree-claude-models-");
    const markerPath = path.join(toolchainBinDir, "claude-cli-path.log");
    const managedClaudePath = path.join(toolchainBinDir, "claude");
    await fs.writeFile(managedClaudePath, "#!/bin/sh\nexit 0\n");
    await fs.chmod(managedClaudePath, 0o755);
    await writeBridgeServer(appRoot, "claude-bridge", markerPath, {
      models: [
        {
          id: "claude-opus-5",
          resolvedModel: "claude-opus-5-20260701",
          name: "Claude Opus 5",
          description: "Latest Opus model",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "max"],
          supportsAdaptiveThinking: true,
        },
      ],
      source: "sdk",
      fetchedAt: freshFetchedAt(),
      sdkVersion: "0.2.1",
      cliVersion: "5.0.0",
    });

    const environment = createEnvironment({ worktreePath });
    let releaseHostCacheWrite: (() => void) | undefined;
    const hostCacheWrite = new Promise<void>((resolve) => {
      releaseHostCacheWrite = resolve;
    });
    const { context, updates, emitted } = createContext(environment, {
      cacheAgentModelCatalog: async () => hostCacheWrite,
    });
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    context.toolchainBinDir = toolchainBinDir;
    const commands = createCommandRegistry();

    try {
      const refresh = commands.get("get_claude_model_catalog")?.(
        { environmentId: environment.id, forceRefresh: true },
        context,
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const snapshot = await Promise.race([
        refresh,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Claude model refresh waited for the host cache write")),
            2_000,
          );
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });

      expect(snapshot).toMatchObject({
        environmentId: environment.id,
        source: "sdk",
        sdkVersion: "0.2.1",
        cliVersion: "5.0.0",
        stale: false,
        models: [
          {
            id: "claude-opus-5",
            resolvedModel: "claude-opus-5-20260701",
            name: "Claude Opus 5",
            supportsAdaptiveThinking: true,
            supportedEffortLevels: ["low", "medium", "high", "max"],
          },
        ],
      });
      expect(await fs.readFile(markerPath, "utf8")).toBe(managedClaudePath);
      expect(updates).toContainEqual({ claudeModelCatalog: snapshot });
      expect(emitted).toContainEqual({
        event: "claude-model-catalog-updated",
        payload: snapshot,
      });
      expect(context.storage.cacheAgentModelCatalog).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining([
          expect.objectContaining({ id: "claude-opus-5" }),
        ]),
      );

      const updateCount = updates.length;
      await expect(
        commands.get("get_claude_model_catalog")?.(
          { environmentId: environment.id },
          context,
        ),
      ).resolves.toEqual(snapshot);
      expect(updates).toHaveLength(updateCount);
    } finally {
      releaseHostCacheWrite?.();
      await commands.get("stop_local_claude_server_cmd")?.(
        { environmentId: environment.id },
        context,
      );
    }
  });

  test("returns the persisted Claude catalog as last-known-good when refresh fails", async () => {
    const worktreePath = await createTempDir("ork-electron-worktree-stale-claude-models-");
    const missingBridgeRoot = await createTempDir("ork-electron-missing-claude-models-");
    const cachedCatalog = {
      environmentId: "env-local",
      models: [{ id: "claude-opus-5", name: "Claude Opus 5" }],
      source: "sdk" as const,
      fetchedAt: new Date().toISOString(),
      stale: false,
    };
    const environment = createEnvironment({
      worktreePath,
      claudeModelCatalog: cachedCatalog,
    });
    const { context, updates } = createContext(environment);
    context.appRoot = missingBridgeRoot;
    context.resourceRoot = missingBridgeRoot;

    const snapshot = await createCommandRegistry()
      .get("get_claude_model_catalog")?.(
        { environmentId: environment.id },
        context,
      );

    expect(snapshot).toMatchObject({
      environmentId: environment.id,
      models: cachedCatalog.models,
      source: "last-known-good",
      stale: true,
    });
    expect(snapshot).toHaveProperty("error");
    expect(updates).toContainEqual({ claudeModelCatalog: snapshot });
  });

  test("does not persist bundled Claude fallback models in the host cache", async () => {
    const appRoot = await createTempDir("ork-electron-app-claude-fallback-models-");
    const worktreePath = await createTempDir("ork-electron-worktree-claude-fallback-models-");
    await writeBridgeServer(appRoot, "claude-bridge", undefined, {
      models: [{ id: "claude-sonnet-fallback", name: "Claude Sonnet Fallback" }],
      source: "fallback",
      fetchedAt: freshFetchedAt(),
    });

    const environment = createEnvironment({ worktreePath });
    const { context, updates, emitted } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();

    try {
      const snapshot = await commands.get("get_claude_model_catalog")?.(
        { environmentId: environment.id, forceRefresh: true },
        context,
      );

      expect(snapshot).toMatchObject({
        environmentId: environment.id,
        source: "fallback",
        stale: true,
        models: [{ id: "claude-sonnet-fallback" }],
      });
      expect(updates).toContainEqual({ claudeModelCatalog: snapshot });
      expect(emitted).toContainEqual({
        event: "claude-model-catalog-updated",
        payload: snapshot,
      });
      expect(context.storage.cacheAgentModelCatalog).not.toHaveBeenCalled();
    } finally {
      await commands.get("stop_local_claude_server_cmd")?.(
        { environmentId: environment.id },
        context,
      );
    }
  });

  test("discovers and persists the Claude model catalog from a containerized bridge", async () => {
    const hostPort = await reserveFreePort();
    const pidFile = path.join(
      await createTempDir("ork-claude-models-container-pid-"),
      "pid",
    );
    const modelsJson = JSON.stringify({
      models: [
        {
          id: "claude-opus-5",
          resolvedModel: "claude-opus-5-20260701",
          name: "Claude Opus 5",
          description: "Latest Opus model",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "max"],
          supportsAdaptiveThinking: true,
        },
      ],
      source: "sdk",
      fetchedAt: freshFetchedAt(),
      sdkVersion: "0.2.1",
      cliVersion: "5.0.0",
    });

    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const { context, updates, emitted } = createContext(environment, {
      cacheAgentModelCatalog: async () => {
        throw new Error("injected host cache failure");
      },
    });
    const commands = createCommandRegistry();
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);

    const previousHostPort = process.env.FAKE_BRIDGE_HOST_PORT;
    const previousPidFile = process.env.FAKE_BRIDGE_PID_FILE;
    const previousModelsJson = process.env.FAKE_CLAUDE_MODELS_JSON;
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
    process.env.FAKE_BRIDGE_PID_FILE = pidFile;
    process.env.FAKE_CLAUDE_MODELS_JSON = modelsJson;

    // Fake docker: report the container running, map the bridge port to our host
    // port, and on `exec -d` spin up a real server that answers both the health
    // probe and the /config/models discovery request.
    const dockerScript = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    bun -e 'const m=process.env.FAKE_CLAUDE_MODELS_JSON;require("node:http").createServer((q,s)=>{if(q.url==="/global/health"||q.url==="/global/auth-check"){s.writeHead(200,{"content-type":"application/json"});return s.end("{}")}if(q.url==="/config/models"){s.writeHead(200,{"content-type":"application/json","access-control-allow-origin":"*"});return s.end(m)}s.writeHead(404);s.end()}).listen(Number(process.env.FAKE_BRIDGE_HOST_PORT),"127.0.0.1")' >/dev/null 2>&1 &
    printf '%s' "$!" > "$FAKE_BRIDGE_PID_FILE"
    exit 0 ;;
esac
exit 0
`;

    try {
      await withFakeDocker(dockerScript, async () => {
        const snapshot = await commands.get("get_claude_model_catalog")?.(
          { environmentId: environment.id, forceRefresh: true },
          context,
        );

        expect(snapshot).toMatchObject({
          environmentId: environment.id,
          source: "sdk",
          sdkVersion: "0.2.1",
          cliVersion: "5.0.0",
          stale: false,
          models: [
            {
              id: "claude-opus-5",
              resolvedModel: "claude-opus-5-20260701",
              name: "Claude Opus 5",
              supportsAdaptiveThinking: true,
              supportedEffortLevels: ["low", "medium", "high", "max"],
            },
          ],
        });
        expect(updates).toContainEqual({ claudeModelCatalog: snapshot });
        expect(emitted).toContainEqual({
          event: "claude-model-catalog-updated",
          payload: snapshot,
        });
        await Promise.resolve();
        expect(warning).toHaveBeenCalledWith(
          "[ElectronBackend] Failed to persist the Claude model catalogue:",
          "injected host cache failure",
        );
      });
    } finally {
      warning.mockRestore();
      const pid = await fs.readFile(pidFile, "utf8").catch(() => "");
      if (pid) {
        try {
          process.kill(Number(pid));
        } catch {
          // already gone
        }
      }
      if (previousHostPort === undefined) delete process.env.FAKE_BRIDGE_HOST_PORT;
      else process.env.FAKE_BRIDGE_HOST_PORT = previousHostPort;
      if (previousPidFile === undefined) delete process.env.FAKE_BRIDGE_PID_FILE;
      else process.env.FAKE_BRIDGE_PID_FILE = previousPidFile;
      if (previousModelsJson === undefined) delete process.env.FAKE_CLAUDE_MODELS_JSON;
      else process.env.FAKE_CLAUDE_MODELS_JSON = previousModelsJson;
    }
  });

  test("launches the local opencode server through the managed toolchain cache", async () => {
    const appRoot = await createTempDir("ork-electron-app-opencode-");
    const toolchainBinDir = await createTempDir("ork-electron-tools-opencode-");
    const worktreePath = await createTempDir("ork-electron-worktree-opencode-");

    const markerPath = path.join(toolchainBinDir, "opencode-was-used.log");
    const opencodeWrapperPath = path.join(toolchainBinDir, "opencode");
    await fs.writeFile(
      opencodeWrapperPath,
      `#!/bin/sh
printf 'used %s\\n' "$*" >> "${markerPath}"
PORT=""
HOST="127.0.0.1"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --port)
      shift
      PORT="$1"
      ;;
    --hostname)
      shift
      HOST="$1"
      ;;
  esac
  shift
done
exec env PORT_ARG="$PORT" HOST_ARG="$HOST" node -e 'const http = require("node:http"); const port = Number(process.env.PORT_ARG); const host = process.env.HOST_ARG || "127.0.0.1"; const expected = "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_SERVER_PASSWORD).toString("base64"); http.createServer((req, res) => { if (req.headers.authorization !== expected) { res.writeHead(401); res.end(); return; } if (req.url === "/global/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); return; } res.writeHead(404); res.end(); }).listen(port, host);'
`,
    );
    await fs.chmod(opencodeWrapperPath, 0o755);

    const environment = createEnvironment({ worktreePath });
    const { context, updates } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    context.toolchainBinDir = toolchainBinDir;

    const commands = createCommandRegistry();
    await expect(commands.get("check_opencode_cli")?.({}, context)).resolves.toBe(true);
    const result = await commands.get("start_local_opencode_server_cmd")?.({ environmentId: environment.id }, context) as {
      port: number;
      pid: number;
      wasRunning: boolean;
      authToken: string;
    };

    try {
      expect(result.wasRunning).toBe(false);
      expect(result.port).toBeGreaterThan(0);
      expect(result.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      await expect(requestOk(result.port, "/global/health")).resolves.toBe(false);
      await expect(requestOk(result.port, "/global/health", {
        Authorization:
          `Basic ${Buffer.from(`opencode:${result.authToken}`).toString("base64")}`,
      })).resolves.toBe(true);
      expect(await fs.readFile(markerPath, "utf8")).toContain("used serve --port");
      expect(updates).toContainEqual({ localOpencodePort: result.port, opencodePid: result.pid });
    } finally {
      await commands.get("stop_local_opencode_server_cmd")?.({ environmentId: environment.id }, context);
    }
  });

  test("reports managed AI CLIs in priority order and falls back when none are installed", async () => {
    const root = await createTempDir("ork-electron-cli-checks-");
    const { context } = createContext(createEnvironment());
    context.appRoot = root;
    context.resourceRoot = root;
    context.toolchainBinDir = root;
    const commands = createCommandRegistry();
    const previousPath = process.env.PATH;

    try {
      process.env.PATH = "";
      await fs.writeFile(path.join(root, "codex"), "managed codex");
      await fs.writeFile(path.join(root, "opencode"), "managed opencode");

      await expect(commands.get("check_claude_cli")?.({}, context)).resolves.toBe(false);
      await expect(commands.get("check_opencode_cli")?.({}, context)).resolves.toBe(true);
      await expect(commands.get("check_codex_cli")?.({}, context)).resolves.toBe(true);
      await expect(commands.get("check_any_ai_cli")?.({}, context)).resolves.toBe(true);
      await expect(commands.get("get_available_ai_cli")?.({}, context)).resolves.toBe("opencode");

      await fs.writeFile(path.join(root, "claude"), "managed claude");
      await expect(commands.get("get_available_ai_cli")?.({}, context)).resolves.toBe("claude");

      await Promise.all(["claude", "opencode", "codex"].map((name) =>
        fs.rm(path.join(root, name), { force: true })
      ));
      await expect(commands.get("check_any_ai_cli")?.({}, context)).resolves.toBe(false);
      await expect(commands.get("get_available_ai_cli")?.({}, context)).resolves.toBeNull();
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  test("starts the in-container Codex bridge with bun and its configured thread limit", async () => {
    const hostPort = await reserveFreePort();
    const pidFile = path.join(await createTempDir("ork-bridge-pid-"), "pid");
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment, {
      globalConfig: { codexMaxConcurrentThreads: 9 },
    });
    const commands = createCommandRegistry();

    const previousHostPort = process.env.FAKE_BRIDGE_HOST_PORT;
    const previousPidFile = process.env.FAKE_BRIDGE_PID_FILE;
    const previousTokenFile = process.env.FAKE_BRIDGE_TOKEN_FILE;
    const tokenFile = path.join(path.dirname(pidFile), "token");
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
    process.env.FAKE_BRIDGE_PID_FILE = pidFile;
    process.env.FAKE_BRIDGE_TOKEN_FILE = tokenFile;

    // Fake docker: report the container running, map the bridge port to our host
    // port, and on `exec -d` spin up a real health endpoint so waitForHealth
    // resolves. stdout is redirected so the detached server does not keep the
    // `docker exec` pipe open. The exec command itself is logged for assertions.
    const dockerScript = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *"cat /tmp/codex-bridge-token"*)
        cat "$FAKE_BRIDGE_TOKEN_FILE" 2>/dev/null || true
        exit 0 ;;
    esac
    token=$(printf '%s' "$*" | sed -n "s/.*CODEX_BRIDGE_TOKEN='\\([^']*\\)'.*/\\1/p")
    printf '%s' "$token" > "$FAKE_BRIDGE_TOKEN_FILE"
    bun -e 'require("node:http").createServer((q,s)=>{s.writeHead(q.url==="/global/health"||q.url==="/global/auth-check"?200:404,{"content-type":"application/json"});s.end("{}")}).listen(Number(process.env.FAKE_BRIDGE_HOST_PORT),"127.0.0.1")' >/dev/null 2>&1 &
    printf '%s' "$!" > "$FAKE_BRIDGE_PID_FILE"
    exit 0 ;;
esac
exit 0
`;

    try {
      await withFakeDocker(dockerScript, async (logs) => {
        const [first, second] = await Promise.all([
          commands.get("start_codex_server")?.(
            { containerId: "container-1" },
            context,
          ),
          commands.get("start_codex_server")?.(
            { containerId: "container-1" },
            context,
          ),
        ]) as Array<{ hostPort: number; wasRunning: boolean; authToken: string }>;
        expect(first).toMatchObject({ hostPort, wasRunning: false });
        expect(second).toMatchObject({ hostPort, wasRunning: true });
        expect(first.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(second.authToken).toBe(first.authToken);

        const execLog = await fs.readFile(logs.exec, "utf8");
        expect(
          execLog.split("\n").filter((line) => line.startsWith("exec -d ")),
        ).toHaveLength(1);
        expect(execLog).toContain("/tmp/codex-bridge-token");
        expect(execLog).toContain("export CODEX_BRIDGE_TOKEN=");
        expect(execLog).toContain("export CODEX_MAX_CONCURRENT_THREADS_PER_SESSION=9");
        expect(execLog).toContain("setsid bun /opt/codex-bridge/dist/index.js");
        expect(execLog).not.toContain("setsid node");
      });
    } finally {
      const pid = await fs.readFile(pidFile, "utf8").catch(() => "");
      if (pid) {
        try {
          process.kill(Number(pid));
        } catch {
          // already gone
        }
      }
      if (previousHostPort === undefined) delete process.env.FAKE_BRIDGE_HOST_PORT;
      else process.env.FAKE_BRIDGE_HOST_PORT = previousHostPort;
      if (previousPidFile === undefined) delete process.env.FAKE_BRIDGE_PID_FILE;
      else process.env.FAKE_BRIDGE_PID_FILE = previousPidFile;
      if (previousTokenFile === undefined) delete process.env.FAKE_BRIDGE_TOKEN_FILE;
      else process.env.FAKE_BRIDGE_TOKEN_FILE = previousTokenFile;
    }
  });

  test("keeps the in-container Claude bridge on its bun entrypoint", async () => {
    const hostPort = await reserveFreePort();
    const pidFile = path.join(await createTempDir("ork-claude-bridge-pid-"), "pid");
    const environment = createEnvironment({
      id: "env-container-claude",
      environmentType: "containerized",
      containerId: "container-claude",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    const previousHostPort = process.env.FAKE_BRIDGE_HOST_PORT;
    const previousPidFile = process.env.FAKE_BRIDGE_PID_FILE;
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
    process.env.FAKE_BRIDGE_PID_FILE = pidFile;

    const dockerScript = `#!/bin/sh
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    bun -e 'require("node:http").createServer((q,s)=>{s.writeHead(q.url==="/global/health"||q.url==="/global/auth-check"?200:404,{"content-type":"application/json"});s.end("{}")}).listen(Number(process.env.FAKE_BRIDGE_HOST_PORT),"127.0.0.1")' >/dev/null 2>&1 &
    printf '%s' "$!" > "$FAKE_BRIDGE_PID_FILE"
    exit 0 ;;
esac
exit 0
`;

    try {
      await withFakeDocker(dockerScript, async (logs) => {
        const result = await commands.get("start_claude_server")?.(
          { containerId: "container-claude" },
          context,
        ) as { hostPort: number; wasRunning: boolean; authToken: string };
        expect(result).toMatchObject({ hostPort, wasRunning: false });
        expect(result.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

        const execLog = await fs.readFile(logs.exec, "utf8");
        expect(execLog).toContain("setsid bun /opt/claude-bridge/dist/index.js");
        expect(execLog).not.toContain("setsid node");
        expect(execLog).toContain("/tmp/claude-bridge-token");
        expect(execLog).toContain("export CLAUDE_BRIDGE_TOKEN=");
      });
    } finally {
      const pid = await fs.readFile(pidFile, "utf8").catch(() => "");
      if (pid) {
        try {
          process.kill(Number(pid));
        } catch {
          // already gone
        }
      }
      if (previousHostPort === undefined) delete process.env.FAKE_BRIDGE_HOST_PORT;
      else process.env.FAKE_BRIDGE_HOST_PORT = previousHostPort;
      if (previousPidFile === undefined) delete process.env.FAKE_BRIDGE_PID_FILE;
      else process.env.FAKE_BRIDGE_PID_FILE = previousPidFile;
    }
  });

  test("starts, replaces, and reuses an authenticated container OpenCode server", async () => {
    const hostPort = await reserveFreePort();
    const stateDir = await createTempDir("ork-opencode-container-auth-");
    const tokenFile = path.join(stateDir, "persisted-password");
    const liveTokenFile = path.join(stateDir, "live-password");
    const healthyFile = path.join(stateDir, "healthy");
    const environment = createEnvironment({
      id: "env-container-opencode-auth",
      environmentType: "containerized",
      containerId: "container-opencode-auth",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const previous = {
      hostPort: process.env.FAKE_BRIDGE_HOST_PORT,
      tokenFile: process.env.FAKE_BRIDGE_TOKEN_FILE,
      liveTokenFile: process.env.FAKE_BRIDGE_LIVE_TOKEN_FILE,
      healthyFile: process.env.FAKE_BRIDGE_HEALTHY_FILE,
    };
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
    process.env.FAKE_BRIDGE_TOKEN_FILE = tokenFile;
    process.env.FAKE_BRIDGE_LIVE_TOKEN_FILE = liveTokenFile;
    process.env.FAKE_BRIDGE_HEALTHY_FILE = healthyFile;

    const bridge = await startAuthenticatedContainerServer(hostPort, {
      isHealthy: () => existsSync(healthyFile),
      isAuthorized: (request) =>
        request.headers.authorization === `Basic ${
          Buffer.from(`opencode:${readTestCredential(liveTokenFile)}`).toString("base64")
        }`,
    });
    const dockerScript = `#!/bin/sh
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *"cat /tmp/opencode-server-password"*)
        cat "$FAKE_BRIDGE_TOKEN_FILE" 2>/dev/null || true
        exit 0 ;;
      *"pkill -f '[o]pencode serve'"*)
        rm -f "$FAKE_BRIDGE_HEALTHY_FILE" "$FAKE_BRIDGE_TOKEN_FILE"
        exit 0 ;;
    esac
    token=$(printf '%s' "$*" | sed -n "s/.*OPENCODE_SERVER_PASSWORD='\\([^']*\\)'.*/\\1/p")
    printf '%s' "$token" > "$FAKE_BRIDGE_TOKEN_FILE"
    printf '%s' "$token" > "$FAKE_BRIDGE_LIVE_TOKEN_FILE"
    : > "$FAKE_BRIDGE_HEALTHY_FILE"
    exit 0 ;;
esac
exit 0
`;

    try {
      await withFakeDocker(dockerScript, async (logs) => {
        const first = await commands.get("start_opencode_server")?.(
          { containerId: "container-opencode-auth" },
          context,
        ) as { hostPort: number; wasRunning: boolean; authToken: string };
        expect(first).toMatchObject({ hostPort, wasRunning: false });
        expect(first.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

        // A reachable legacy process without a readable password is replaced,
        // rather than being handed to the renderer unauthenticated.
        await fs.rm(tokenFile);
        const legacyReplacement = await commands.get("start_opencode_server")?.(
          { containerId: "container-opencode-auth" },
          context,
        ) as { hostPort: number; wasRunning: boolean; authToken: string };
        expect(legacyReplacement).toMatchObject({ hostPort, wasRunning: false });
        expect(legacyReplacement.authToken).not.toBe(first.authToken);

        const stalePassword = "S".repeat(43);
        await fs.writeFile(tokenFile, stalePassword);
        await fs.writeFile(liveTokenFile, "L".repeat(43));
        const replacement = await commands.get("start_opencode_server")?.(
          { containerId: "container-opencode-auth" },
          context,
        ) as { hostPort: number; wasRunning: boolean; authToken: string };
        expect(replacement).toMatchObject({ hostPort, wasRunning: false });
        expect(replacement.authToken).not.toBe(stalePassword);

        await expect(
          commands.get("start_opencode_server")?.(
            { containerId: "container-opencode-auth" },
            context,
          ),
        ).resolves.toEqual({
          hostPort,
          wasRunning: true,
          authToken: replacement.authToken,
        });

        const execLog = await fs.readFile(logs.exec, "utf8");
        expect(
          execLog.split("\n").filter((line) => line.startsWith("exec -d ")),
        ).toHaveLength(3);
        expect(execLog).toContain("pkill -f '[o]pencode serve'");
      });
    } finally {
      await bridge.close();
      for (const [key, value] of Object.entries(previous)) {
        const envName = {
          hostPort: "FAKE_BRIDGE_HOST_PORT",
          tokenFile: "FAKE_BRIDGE_TOKEN_FILE",
          liveTokenFile: "FAKE_BRIDGE_LIVE_TOKEN_FILE",
          healthyFile: "FAKE_BRIDGE_HEALTHY_FILE",
        }[key]!;
        if (value === undefined) delete process.env[envName];
        else process.env[envName] = value;
      }
    }
  });

  test("replaces a healthy Claude bridge when its persisted token does not authenticate", async () => {
    const hostPort = await reserveFreePort();
    const stateDir = await createTempDir("ork-claude-stale-identity-");
    const tokenFile = path.join(stateDir, "persisted-token");
    const liveTokenFile = path.join(stateDir, "live-token");
    const healthyFile = path.join(stateDir, "healthy");
    const staleToken = "S".repeat(43);
    await fs.writeFile(tokenFile, staleToken);
    await fs.writeFile(liveTokenFile, "L".repeat(43));
    await fs.writeFile(healthyFile, "");

    const environment = createEnvironment({
      id: "env-container-claude-stale",
      environmentType: "containerized",
      containerId: "container-claude-stale",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const previous = {
      hostPort: process.env.FAKE_BRIDGE_HOST_PORT,
      tokenFile: process.env.FAKE_BRIDGE_TOKEN_FILE,
      liveTokenFile: process.env.FAKE_BRIDGE_LIVE_TOKEN_FILE,
      healthyFile: process.env.FAKE_BRIDGE_HEALTHY_FILE,
    };
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
    process.env.FAKE_BRIDGE_TOKEN_FILE = tokenFile;
    process.env.FAKE_BRIDGE_LIVE_TOKEN_FILE = liveTokenFile;
    process.env.FAKE_BRIDGE_HEALTHY_FILE = healthyFile;

    const bridge = await startAuthenticatedContainerServer(hostPort, {
      isHealthy: () => existsSync(healthyFile),
      isAuthorized: (request) =>
        request.headers["x-orkestrator-claude-token"]
          === readTestCredential(liveTokenFile),
    });
    const dockerScript = `#!/bin/sh
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *"cat /tmp/claude-bridge-token"*)
        cat "$FAKE_BRIDGE_TOKEN_FILE" 2>/dev/null || true
        exit 0 ;;
      *"pkill -f '[c]laude-bridge/dist/index.js'"*)
        rm -f "$FAKE_BRIDGE_HEALTHY_FILE"
        exit 0 ;;
    esac
    token=$(printf '%s' "$*" | sed -n "s/.*CLAUDE_BRIDGE_TOKEN='\\([^']*\\)'.*/\\1/p")
    printf '%s' "$token" > "$FAKE_BRIDGE_TOKEN_FILE"
    printf '%s' "$token" > "$FAKE_BRIDGE_LIVE_TOKEN_FILE"
    : > "$FAKE_BRIDGE_HEALTHY_FILE"
    exit 0 ;;
esac
exit 0
`;

    try {
      await withFakeDocker(dockerScript, async (logs) => {
        await expect(
          commands.get("get_claude_server_status")?.(
            { containerId: "container-claude-stale" },
            context,
          ),
        ).resolves.toEqual({ running: true, hostPort });

        const result = await commands.get("start_claude_server")?.(
          { containerId: "container-claude-stale" },
          context,
        ) as { hostPort: number; wasRunning: boolean; authToken: string };

        expect(result).toMatchObject({ hostPort, wasRunning: false });
        expect(result.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(result.authToken).not.toBe(staleToken);
        expect(readTestCredential(liveTokenFile)).toBe(result.authToken);
        expect(await fs.readFile(logs.exec, "utf8")).toContain(
          "pkill -f '[c]laude-bridge/dist/index.js'",
        );
      });
    } finally {
      await bridge.close();
      for (const [key, value] of Object.entries(previous)) {
        const envName = {
          hostPort: "FAKE_BRIDGE_HOST_PORT",
          tokenFile: "FAKE_BRIDGE_TOKEN_FILE",
          liveTokenFile: "FAKE_BRIDGE_LIVE_TOKEN_FILE",
          healthyFile: "FAKE_BRIDGE_HEALTHY_FILE",
        }[key]!;
        if (value === undefined) delete process.env[envName];
        else process.env[envName] = value;
      }
    }
  });

  test("authenticates the persisted Claude token when a bridge arrives between health checks", async () => {
    const hostPort = await reserveFreePort();
    const tokenFile = path.join(
      await createTempDir("ork-claude-late-identity-"),
      "token",
    );
    const persistedToken = "P".repeat(43);
    await fs.writeFile(tokenFile, persistedToken);
    const environment = createEnvironment({
      id: "env-container-claude-late",
      environmentType: "containerized",
      containerId: "container-claude-late",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const previousHostPort = process.env.FAKE_BRIDGE_HOST_PORT;
    const previousTokenFile = process.env.FAKE_BRIDGE_TOKEN_FILE;
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
    process.env.FAKE_BRIDGE_TOKEN_FILE = tokenFile;

    let healthChecks = 0;
    const bridge = await startAuthenticatedContainerServer(hostPort, {
      isHealthy: () => (healthChecks += 1) > 1,
      isAuthorized: (request) =>
        request.headers["x-orkestrator-claude-token"] === persistedToken,
    });
    const dockerScript = `#!/bin/sh
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *"cat /tmp/claude-bridge-token"*)
        cat "$FAKE_BRIDGE_TOKEN_FILE"
        exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0
`;

    try {
      await withFakeDocker(dockerScript, async (logs) => {
        await expect(
          commands.get("start_claude_server")?.(
            { containerId: "container-claude-late" },
            context,
          ),
        ).resolves.toEqual({
          hostPort,
          wasRunning: true,
          authToken: persistedToken,
        });
        expect(await fs.readFile(logs.exec, "utf8")).not.toContain("exec -d ");
      });
    } finally {
      await bridge.close();
      if (previousHostPort === undefined) delete process.env.FAKE_BRIDGE_HOST_PORT;
      else process.env.FAKE_BRIDGE_HOST_PORT = previousHostPort;
      if (previousTokenFile === undefined) delete process.env.FAKE_BRIDGE_TOKEN_FILE;
      else process.env.FAKE_BRIDGE_TOKEN_FILE = previousTokenFile;
    }
  });

  test.each([
    [
      "Claude",
      "start_claude_server",
      "container-claude-redaction",
      "CLAUDE_BRIDGE_TOKEN",
    ],
    [
      "OpenCode",
      "start_opencode_server",
      "container-opencode-redaction",
      "OPENCODE_SERVER_PASSWORD",
    ],
  ] as const)(
    "redacts a generated %s container credential when detached startup fails",
    async (_label, commandName, containerId, credentialName) => {
      const hostPort = await reserveFreePort();
      const environment = createEnvironment({
        id: `env-${containerId}`,
        environmentType: "containerized",
        containerId,
        status: "running",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const previousHostPort = process.env.FAKE_BRIDGE_HOST_PORT;
      process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
      const dockerScript = `#!/bin/sh
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *"cat /tmp/claude-bridge-token"*|*"cat /tmp/opencode-server-password"*)
        exit 0 ;;
    esac
    exit 9 ;;
esac
exit 0
`;

      try {
        await withFakeDocker(dockerScript, async (logs) => {
          const failure = await commands.get(commandName)?.(
            { containerId },
            context,
          ).then(() => null, (error: unknown) => error as Error);

          expect(failure).toBeInstanceOf(Error);
          const execLog = await fs.readFile(logs.exec, "utf8");
          const token = execLog.match(
            new RegExp(`${credentialName}='([^']+)'`),
          )?.[1];
          expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
          expect(failure!.message).not.toContain(token!);
          expect(failure!.message).toContain("[REDACTED]");
        });
      } finally {
        if (previousHostPort === undefined) delete process.env.FAKE_BRIDGE_HOST_PORT;
        else process.env.FAKE_BRIDGE_HOST_PORT = previousHostPort;
      }
    },
  );

  test("defaults a malformed in-container Codex thread limit before shell interpolation", async () => {
    const hostPort = await reserveFreePort();
    const pidFile = path.join(await createTempDir("ork-codex-fallback-pid-"), "pid");
    const environment = createEnvironment({
      id: "env-container-codex-fallback",
      environmentType: "containerized",
      containerId: "container-codex-fallback",
      status: "running",
    });
    const { context } = createContext(environment, {
      globalConfig: { codexMaxConcurrentThreads: "invalid" },
    });
    const commands = createCommandRegistry();

    const previousHostPort = process.env.FAKE_BRIDGE_HOST_PORT;
    const previousPidFile = process.env.FAKE_BRIDGE_PID_FILE;
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
    process.env.FAKE_BRIDGE_PID_FILE = pidFile;

    const dockerScript = `#!/bin/sh
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    bun -e 'require("node:http").createServer((q,s)=>{s.writeHead(q.url==="/global/health"?200:404);s.end()}).listen(Number(process.env.FAKE_BRIDGE_HOST_PORT),"127.0.0.1")' >/dev/null 2>&1 &
    printf '%s' "$!" > "$FAKE_BRIDGE_PID_FILE"
    exit 0 ;;
esac
exit 0
`;

    try {
      await withFakeDocker(dockerScript, async (logs) => {
        await commands.get("start_codex_server")?.(
          { containerId: "container-codex-fallback" },
          context,
        );
        const execLog = await fs.readFile(logs.exec, "utf8");
        expect(execLog).toContain("export CODEX_MAX_CONCURRENT_THREADS_PER_SESSION=5");
        expect(execLog).not.toContain("invalid");
      });
    } finally {
      const pid = await fs.readFile(pidFile, "utf8").catch(() => "");
      if (pid) {
        try {
          process.kill(Number(pid));
        } catch {
          // already gone
        }
      }
      if (previousHostPort === undefined) delete process.env.FAKE_BRIDGE_HOST_PORT;
      else process.env.FAKE_BRIDGE_HOST_PORT = previousHostPort;
      if (previousPidFile === undefined) delete process.env.FAKE_BRIDGE_PID_FILE;
      else process.env.FAKE_BRIDGE_PID_FILE = previousPidFile;
    }
  });

  test("replaces an in-container Codex bridge that has no usable persisted token", async () => {
    const hostPort = await reserveFreePort();
    const stateDir = await createTempDir("ork-codex-legacy-bridge-");
    const tokenFile = path.join(stateDir, "token");
    const killedFile = path.join(stateDir, "killed");
    // A bridge from before per-process authentication: healthy, but its token
    // file holds something the renderer cannot use.
    await fs.writeFile(tokenFile, "legacy");

    const environment = createEnvironment({
      id: "env-container-codex-legacy",
      environmentType: "containerized",
      containerId: "container-codex-legacy",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    const previousHostPort = process.env.FAKE_BRIDGE_HOST_PORT;
    const previousTokenFile = process.env.FAKE_BRIDGE_TOKEN_FILE;
    const previousKilledFile = process.env.FAKE_BRIDGE_KILLED_FILE;
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
    process.env.FAKE_BRIDGE_TOKEN_FILE = tokenFile;
    process.env.FAKE_BRIDGE_KILLED_FILE = killedFile;

    // The bridge is healthy until `pkill` drops the marker, and healthy again
    // once the start script has run.
    const bridge = await startControllableHealthServer(hostPort, () => !existsSync(killedFile));

    const dockerScript = `#!/bin/sh
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *"cat /tmp/codex-bridge-token"*)
        cat "$FAKE_BRIDGE_TOKEN_FILE" 2>/dev/null || true
        exit 0 ;;
      *"pkill -f '[c]odex-bridge/dist/index.js'"*)
        : > "$FAKE_BRIDGE_KILLED_FILE"
        exit 0 ;;
    esac
    token=$(printf '%s' "$*" | sed -n "s/.*CODEX_BRIDGE_TOKEN='\\([^']*\\)'.*/\\1/p")
    printf '%s' "$token" > "$FAKE_BRIDGE_TOKEN_FILE"
    rm -f "$FAKE_BRIDGE_KILLED_FILE"
    exit 0 ;;
esac
exit 0
`;

    try {
      await withFakeDocker(dockerScript, async (logs) => {
        const result = await commands.get("start_codex_server")?.(
          { containerId: "container-codex-legacy" },
          context,
        ) as { hostPort: number; wasRunning: boolean; authToken: string };

        expect(result).toMatchObject({ hostPort, wasRunning: false });
        expect(result.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(await fs.readFile(tokenFile, "utf8")).toBe(result.authToken);

        const execLog = await fs.readFile(logs.exec, "utf8");
        expect(execLog).toContain("pkill -f '[c]odex-bridge/dist/index.js'");
        expect(
          execLog.split("\n").filter((line) => line.startsWith("exec -d ")),
        ).toHaveLength(1);
      });
    } finally {
      await bridge.close();
      if (previousHostPort === undefined) delete process.env.FAKE_BRIDGE_HOST_PORT;
      else process.env.FAKE_BRIDGE_HOST_PORT = previousHostPort;
      if (previousTokenFile === undefined) delete process.env.FAKE_BRIDGE_TOKEN_FILE;
      else process.env.FAKE_BRIDGE_TOKEN_FILE = previousTokenFile;
      if (previousKilledFile === undefined) delete process.env.FAKE_BRIDGE_KILLED_FILE;
      else process.env.FAKE_BRIDGE_KILLED_FILE = previousKilledFile;
    }
  });

  test("returns the container's persisted token when a bridge arrives after the health check", async () => {
    const hostPort = await reserveFreePort();
    const stateDir = await createTempDir("ork-codex-late-bridge-");
    const tokenFile = path.join(stateDir, "token");
    const persistedToken = "L".repeat(43);
    await fs.writeFile(tokenFile, persistedToken);

    const environment = createEnvironment({
      id: "env-container-codex-late",
      environmentType: "containerized",
      containerId: "container-codex-late",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    const previousHostPort = process.env.FAKE_BRIDGE_HOST_PORT;
    const previousTokenFile = process.env.FAKE_BRIDGE_TOKEN_FILE;
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
    process.env.FAKE_BRIDGE_TOKEN_FILE = tokenFile;

    // Unhealthy for the handler's own check and healthy by the time
    // startContainerServer re-checks: a prior start whose health wait timed out
    // but whose bridge came up late.
    let healthChecks = 0;
    const bridge = await startControllableHealthServer(hostPort, () => (healthChecks += 1) > 1);

    const dockerScript = `#!/bin/sh
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *"cat /tmp/codex-bridge-token"*)
        cat "$FAKE_BRIDGE_TOKEN_FILE" 2>/dev/null || true
        exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0
`;

    try {
      await withFakeDocker(dockerScript, async (logs) => {
        const result = await commands.get("start_codex_server")?.(
          { containerId: "container-codex-late" },
          context,
        ) as { hostPort: number; wasRunning: boolean; authToken: string };

        expect(result).toEqual({ hostPort, wasRunning: true, authToken: persistedToken });
        expect(await fs.readFile(tokenFile, "utf8")).toBe(persistedToken);

        const execLog = await fs.readFile(logs.exec, "utf8");
        expect(execLog).not.toContain("exec -d ");
      });
    } finally {
      await bridge.close();
      if (previousHostPort === undefined) delete process.env.FAKE_BRIDGE_HOST_PORT;
      else process.env.FAKE_BRIDGE_HOST_PORT = previousHostPort;
      if (previousTokenFile === undefined) delete process.env.FAKE_BRIDGE_TOKEN_FILE;
      else process.env.FAKE_BRIDGE_TOKEN_FILE = previousTokenFile;
    }
  });

  test("keeps the Codex bridge token out of a failed docker exec error", async () => {
    const hostPort = await reserveFreePort();
    const environment = createEnvironment({
      id: "env-container-codex-redaction",
      environmentType: "containerized",
      containerId: "container-codex-redaction",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    const previousHostPort = process.env.FAKE_BRIDGE_HOST_PORT;
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);

    // The start exec fails without writing anything, so the only material left
    // for an error message is the argv that carries the token.
    const dockerScript = `#!/bin/sh
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *"cat /tmp/codex-bridge-token"*) exit 0 ;;
    esac
    exit 9 ;;
esac
exit 0
`;

    try {
      await withFakeDocker(dockerScript, async (logs) => {
        const failure = await commands.get("start_codex_server")?.(
          { containerId: "container-codex-redaction" },
          context,
        ).then(() => null, (error: unknown) => error as Error);

        expect(failure).toBeInstanceOf(Error);
        const execLog = await fs.readFile(logs.exec, "utf8");
        const token = execLog.match(/CODEX_BRIDGE_TOKEN='([^']+)'/)?.[1];
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(failure!.message).not.toContain(token!);
        expect(failure!.message).toContain("[REDACTED]");
      });
    } finally {
      if (previousHostPort === undefined) delete process.env.FAKE_BRIDGE_HOST_PORT;
      else process.env.FAKE_BRIDGE_HOST_PORT = previousHostPort;
    }
  });

  test("fails a bridge replacement whose port never stops answering health checks", async () => {
    const hostPort = await reserveFreePort();
    const bridge = await startControllableHealthServer(hostPort, () => true);
    try {
      await expect(commandTesting.waitForUnhealthy(hostPort, 2)).rejects.toThrow(
        `Server on port ${hostPort} did not stop`,
      );
      await expect(commandTesting.waitForHttpServerExit(hostPort, 2)).rejects.toThrow(
        `Server on port ${hostPort} did not stop`,
      );
    } finally {
      await bridge.close();
    }
  });

  test("does not persist local bridge process state when the bridge entrypoint is missing", async () => {
    const appRoot = await createTempDir("ork-electron-app-missing-");
    const worktreePath = await createTempDir("ork-electron-worktree-missing-");
    await fs.mkdir(path.join(appRoot, "bridges", "codex-bridge"), { recursive: true });

    const environment = createEnvironment({ worktreePath });
    const { context, updates } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;

    const commands = createCommandRegistry();
    await expect(commands.get("start_local_codex_server_cmd")?.({ environmentId: environment.id }, context)).rejects.toThrow(
      "codex bridge entrypoint not found",
    );
    expect(updates).toHaveLength(0);
  });

  test("replaces an unhealthy local bridge process before restarting it", async () => {
    const appRoot = await createTempDir("ork-electron-app-stale-bridge-");
    const worktreePath = await createTempDir("ork-electron-worktree-stale-bridge-");
    await writeBridgeEntrypoint(
      appRoot,
      "codex-bridge",
      `
        const http = require("node:http");
        const server = http.createServer((req, res) => {
          if (req.url === "/disable") {
            res.writeHead(200);
            res.end();
            server.close();
            return;
          }
          res.writeHead(req.url === "/global/health" ? 200 : 404);
          res.end();
        });
        server.listen(Number(process.env.PORT), "127.0.0.1");
        setInterval(() => {}, 60_000);
      `,
    );

    const environment = createEnvironment({ worktreePath });
    const { context, updates } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();

    const first = await commands.get("start_local_codex_server_cmd")?.(
      { environmentId: environment.id },
      context,
    ) as { port: number; pid: number; wasRunning: boolean };
    expect(first.wasRunning).toBe(false);
    await expect(requestOk(first.port, "/disable")).resolves.toBe(true);
    await commandTesting.waitForUnhealthy(first.port);

    const replacementCommitStarted = createDeferred();
    const releaseReplacementCommit = createDeferred();
    const updateEnvironment = context.storage.updateEnvironment.bind(context.storage);
    context.storage.updateEnvironment = mock(async (
      environmentId: string,
      update: Record<string, unknown>,
    ) => {
      if (typeof update.localCodexPort === "number") {
        replacementCommitStarted.resolve(undefined);
        await releaseReplacementCommit.promise;
      }
      return updateEnvironment(environmentId, update);
    });

    const replacementPromise = commands.get("start_local_codex_server_cmd")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<{
      port: number;
      pid: number;
      wasRunning: boolean;
      authToken: string;
    }>;
    await replacementCommitStarted.promise;

    let statusReadStarted = false;
    const getEnvironment = context.storage.getEnvironment.bind(context.storage);
    context.storage.getEnvironment = mock(async (environmentId: string) => {
      statusReadStarted = true;
      return getEnvironment(environmentId);
    });
    const statusPromise = commands.get("get_local_codex_server_status")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<{
      running: boolean;
      port: number | null;
      pid: number | null;
      authToken?: string;
    }>;
    try {
      expect(statusReadStarted).toBe(false);
    } finally {
      releaseReplacementCommit.resolve(undefined);
    }
    const [second, status] = await Promise.all([
      replacementPromise,
      statusPromise,
    ]);
    try {
      expect(second.wasRunning).toBe(false);
      expect(second.pid).not.toBe(first.pid);
      expect(second.port).not.toBe(first.port);
      expect(updates.at(-1)).toEqual({
        localCodexPort: second.port,
        codexBridgePid: second.pid,
      });
      expect(status).toEqual({
        running: true,
        port: second.port,
        pid: second.pid,
        authToken: second.authToken,
      });
      await expect(requestOk(second.port, "/global/health")).resolves.toBe(true);
    } finally {
      await commands.get("stop_local_codex_server_cmd")?.(
        { environmentId: environment.id },
        context,
      );
    }
  });

  test("restarts a healthy local Codex bridge whose auth token this process no longer holds", async () => {
    const appRoot = await createTempDir("ork-electron-app-tokenless-bridge-");
    const worktreePath = await createTempDir("ork-electron-worktree-tokenless-bridge-");
    await writeBridgeServer(appRoot, "codex-bridge");

    const environment = createEnvironment({ id: "env-local-tokenless", worktreePath });
    const { context } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();

    const first = await commands.get("start_local_codex_server_cmd")?.(
      { environmentId: environment.id },
      context,
    ) as { port: number; pid: number; authToken: string };
    expect(first.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // A bridge inherited from a previous backend process: still healthy, but its
    // token was never handed to us, so the renderer could not authenticate.
    commandTesting.deleteLocalCodexBridgeToken(environment.id);

    const second = await commands.get("start_local_codex_server_cmd")?.(
      { environmentId: environment.id },
      context,
    ) as { port: number; pid: number; wasRunning: boolean; authToken: string };
    try {
      expect(second.wasRunning).toBe(false);
      expect(second.pid).not.toBe(first.pid);
      expect(second.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(second.authToken).not.toBe(first.authToken);
      expect(isProcessRunning(first.pid)).toBe(false);
      await expect(requestOk(second.port, "/global/health")).resolves.toBe(true);
    } finally {
      await commands.get("stop_local_codex_server_cmd")?.(
        { environmentId: environment.id },
        context,
      );
    }
  });

  test("forgets the local Codex bridge token when the process cannot be spawned", async () => {
    const appRoot = await createTempDir("ork-electron-app-spawn-failure-");
    const worktreePath = await createTempDir("ork-electron-worktree-spawn-failure-");
    await writeBridgeServer(appRoot, "codex-bridge");

    const environment = createEnvironment({ id: "env-local-spawn-failure", worktreePath });
    const { context, updates } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();
    commandTesting.setSpawnLocalServerCommand(() => {
      throw new Error("spawn refused");
    });

    try {
      await expect(
        commands.get("start_local_codex_server_cmd")?.(
          { environmentId: environment.id },
          context,
        ),
      ).rejects.toThrow("spawn refused");
      expect(commandTesting.getLocalCodexBridgeToken(environment.id)).toBeUndefined();
      expect(updates).toHaveLength(0);
    } finally {
      commandTesting.setSpawnLocalServerCommand(spawnCommand);
    }
  });

  test("clears persisted local bridge state when startup exits before health", async () => {
    const appRoot = await createTempDir("ork-electron-app-failed-bridge-");
    const worktreePath = await createTempDir("ork-electron-worktree-failed-bridge-");
    await writeBridgeEntrypoint(
      appRoot,
      "codex-bridge",
      `process.exitCode = 23;`,
    );

    const environment = createEnvironment({ worktreePath });
    const { context, updates } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();

    await expect(
      commands.get("start_local_codex_server_cmd")?.(
        { environmentId: environment.id },
        context,
      ),
    ).rejects.toThrow("codex server exited before becoming healthy");
    expect(updates).toContainEqual({
      localCodexPort: null,
      codexBridgePid: null,
    });
    expect(environment.localCodexPort).toBeNull();
    expect(environment.codexBridgePid).toBeNull();
  });

  test("reports both startup and cleanup failures while clearing persisted state", async () => {
    const appRoot = await createTempDir("ork-electron-app-failed-bridge-cleanup-");
    const worktreePath = await createTempDir("ork-electron-worktree-failed-bridge-cleanup-");
    await writeBridgeEntrypoint(
      appRoot,
      "codex-bridge",
      `process.exitCode = 23;`,
    );

    const environment = createEnvironment({ worktreePath });
    const { context, updates } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();
    commandTesting.setTerminateProcessTree(async () => false);

    await expect(
      commands.get("start_local_codex_server_cmd")?.(
        { environmentId: environment.id },
        context,
      ),
    ).rejects.toThrow("Failed to start and clean up local server");
    expect(updates).toContainEqual({
      localCodexPort: null,
      codexBridgePid: null,
    });
    expect(environment.localCodexPort).toBeNull();
    expect(environment.codexBridgePid).toBeNull();
    commandTesting.setTerminateProcessTree(async () => true);
  });

  test("starts local terminal sessions through a PTY and forwards byte payloads", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-");
    const resourceRoot = await createTempDir("ork-electron-terminal-res-");
    const toolchainBinDir = await createTempDir("ork-electron-terminal-tools-");
    const packagedBinDir = path.join(resourceRoot, "bin");
    await fs.mkdir(packagedBinDir, { recursive: true });
    const environment = createEnvironment({ worktreePath });
    const { context, emitted } = createContext(environment);
    context.resourceRoot = resourceRoot;
    context.toolchainBinDir = toolchainBinDir;
    const commands = createCommandRegistry();

    const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      { environmentId: environment.id, cols: 132, rows: 43 },
      context,
    )).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);

    const spawnCall = ptySpawn.mock.calls[0];
    expect(spawnCall?.[0]).toBe(expectedLocalShellPath());
    expect(spawnCall?.[1]).toEqual(["-l"]);
    expect(spawnCall?.[2]).toMatchObject({
      cols: 132,
      rows: 43,
      cwd: worktreePath,
    });
    const terminalProcessEnv = spawnCall?.[2]?.env as NodeJS.ProcessEnv | undefined;
    expect(terminalProcessEnv?.PATH?.split(path.delimiter).slice(0, 2)).toEqual([
      toolchainBinDir,
      packagedBinDir,
    ]);
    expect(commands.get("get_terminal_session")?.({ sessionId }, context)).toEqual({
      id: sessionId,
      running: true,
    });

    ptyProcesses[0]?.emitData("ready\r\n");
    expect(emitted).toEqual([
      {
        event: `terminal-output-${sessionId}`,
        payload: {
          text: "ready\r\n",
          revision: 1,
          generation: 1,
        },
      },
    ]);

    await commands.get("local_terminal_write")?.({ sessionId, data: "pwd\r" }, context);
    await commands.get("local_terminal_resize")?.({ sessionId, cols: 120, rows: 30 }, context);
    expect(ptyProcesses[0]?.write).toHaveBeenCalledWith("pwd\r");
    expect(ptyProcesses[0]?.resize).toHaveBeenCalledWith(120, 30);

    await commands.get("close_local_terminal_session")?.({ sessionId }, context);
    expect(ptyProcesses[0]?.kill).toHaveBeenCalled();
    expect(commands.get("get_terminal_session")?.({ sessionId }, context)).toEqual({ id: sessionId, running: false });
  });

  test("reattaches a stable terminal tab to the same backend PTY and buffer", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-reattach-");
    const environment = createEnvironment({ worktreePath });
    const { context, emitted } = createContext(environment);
    const commands = createCommandRegistry();
    const args = {
      environmentId: environment.id,
      terminalKey: "plain-tab-1",
      cols: 80,
      rows: 24,
    };

    const firstResult = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      args,
      context,
    ));
    const firstSessionId = firstResult.sessionId;
    expect(firstResult.created).toBe(true);
    await commands.get("start_local_terminal_session")?.(
      { sessionId: firstSessionId },
      context,
    );
    ptyProcesses[0]?.emitData("dev server listening on 3000\r\n");
    ptyProcesses[0]?.emitData("second chunk\r\n");

    // A second renderer (or a remount after project refresh) has only the
    // durable environment + tab identity. Ensuring that identity must return
    // the original running PTY, and starting it again must remain idempotent.
    const reattachedResult = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      args,
      context,
    ));
    const reattachedSessionId = reattachedResult.sessionId;
    expect(reattachedResult.created).toBe(false);
    await commands.get("start_local_terminal_session")?.(
      { sessionId: reattachedSessionId },
      context,
    );

    expect(reattachedSessionId).toBe(firstSessionId);
    expect(ptySpawn).toHaveBeenCalledTimes(1);
    expect(commands.get("get_terminal_output_snapshot")?.(
      { sessionId: reattachedSessionId },
      context,
    )).toEqual({
      output: "dev server listening on 3000\r\nsecond chunk\r\n",
      revision: 2,
      generation: 1,
      truncated: false,
    });
    expect(emitted.filter(({ event }) => event === `terminal-output-${firstSessionId}`))
      .toEqual([
        {
          event: `terminal-output-${firstSessionId}`,
          payload: {
            text: "dev server listening on 3000\r\n",
            revision: 1,
            generation: 1,
          },
        },
        {
          event: `terminal-output-${firstSessionId}`,
          payload: {
            text: "second chunk\r\n",
            revision: 2,
            generation: 1,
          },
        },
      ]);

    // A natural shell exit retains the stable tab identity and bounded
    // transcript. Reopening the tab starts a replacement PTY under that same
    // identity rather than losing its history.
    ptyProcesses[0]?.emitExit({ exitCode: 0 });
    const exitedResult = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      args,
      context,
    ));
    expect(exitedResult).toEqual({ sessionId: firstSessionId, created: false });
    expect(commands.get("get_terminal_output_snapshot")?.(
      { sessionId: firstSessionId },
      context,
    )).toEqual({
      output: "dev server listening on 3000\r\nsecond chunk\r\n",
      revision: 2,
      generation: 1,
      truncated: false,
    });
    await commands.get("start_local_terminal_session")?.(
      { sessionId: exitedResult.sessionId },
      context,
    );
    expect(ptySpawn).toHaveBeenCalledTimes(2);

    await commands.get("close_local_terminal_session")?.(
      { sessionId: firstSessionId },
      context,
    );
    const replacementResult = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      args,
      context,
    ));
    const replacementSessionId = replacementResult.sessionId;
    expect(replacementResult.created).toBe(true);
    expect(replacementSessionId).not.toBe(firstSessionId);
  });

  test("supersedes a stable local terminal when its activity configuration changes", async () => {
    const worktreePath = await createTempDir("ork-electron-local-terminal-supersede-");
    const environment = createEnvironment({
      id: "env-local-terminal-supersede",
      worktreePath,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const baseArgs = {
      environmentId: environment.id,
      terminalKey: "agent-tab",
      cols: 80,
      rows: 24,
    };

    const untracked = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      baseArgs,
      context,
    ));
    await commands.get("start_local_terminal_session")?.(
      { sessionId: untracked.sessionId },
      context,
    );

    const tracked = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      { ...baseArgs, trackEnvironmentActivity: true },
      context,
    ));
    expect(tracked.created).toBe(true);
    expect(tracked.sessionId).not.toBe(untracked.sessionId);
    expect(ptyProcesses[0]?.kill).toHaveBeenCalledTimes(1);

    const reused = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      { ...baseArgs, trackEnvironmentActivity: true },
      context,
    ));
    expect(reused).toEqual({ sessionId: tracked.sessionId, created: false });
  });

  test("records prompt and settled-output activity for tracked local agent terminals", async () => {
    const worktreePath = await createTempDir("ork-electron-local-agent-activity-");
    const environment = createEnvironment({
      id: "env-local-agent-activity",
      worktreePath,
      lastActivityAt: "2026-07-23T09:00:00.000Z",
    });
    const { context, emitted } = createContext(environment);
    const notifyAgentTurnCompleted = mock(async (_environmentId: string) => undefined);
    context.notifyAgentTurnCompleted = notifyAgentTurnCompleted;
    const commands = createCommandRegistry();
    const recordActivity = context.storage.recordEnvironmentActivity as ReturnType<typeof mock>;
    const recordCompletion = context.storage.recordEnvironmentCompletion as ReturnType<typeof mock>;

    const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      {
        environmentId: environment.id,
        cols: 80,
        rows: 24,
        trackEnvironmentActivity: true,
      },
      context,
    )).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);

    await withFixedDate("2026-07-23T10:00:00.000Z", () =>
      commands.get("local_terminal_write")?.({ sessionId, data: "opencode\r" }, context),
    );
    expect(recordActivity).toHaveBeenLastCalledWith(
      environment.id,
      "2026-07-23T10:00:00.000Z",
    );

    await withFixedDate("2026-07-23T10:05:00.000Z", async () => {
      ptyProcesses[0]?.emitData("work complete\r\n");
      await Bun.sleep(TERMINAL_ACTIVITY_SETTLE_TEST_WAIT_MS);
    });
    expect(recordCompletion).toHaveBeenLastCalledWith(
      environment.id,
      "2026-07-23T10:05:00.000Z",
    );
    await waitForCondition(
      () => notifyAgentTurnCompleted.mock.calls.length === 1,
      "the tracked terminal completion notification",
    );
    expect(notifyAgentTurnCompleted).toHaveBeenCalledWith(environment.id);
    expect(environment.hasUnreadWork).toBe(true);
    expect(environment.lastActivityAt).toBe("2026-07-23T10:05:00.000Z");
    await waitForCondition(
      () => emitted.some(({ event, payload }) =>
        event === "environment-activity-recorded" &&
        (payload as { environment_id?: string; occurred_at?: string; activity_kind?: string }).environment_id === environment.id &&
        (payload as { environment_id?: string; occurred_at?: string; activity_kind?: string }).occurred_at === "2026-07-23T10:05:00.000Z" &&
        (payload as { environment_id?: string; occurred_at?: string; activity_kind?: string }).activity_kind === "completed"
      ),
      "the terminal activity event",
    );
    expect(emitted).toContainEqual({
      event: "environment-activity-recorded",
      payload: {
        environment_id: environment.id,
        occurred_at: "2026-07-23T10:00:00.000Z",
        activity_kind: "prompt",
      },
    });
    await commands.get("close_local_terminal_session")?.({ sessionId }, context);
  }, ASYNC_TEST_BUDGET_MS);

  test("retries tracked terminal completion persistence and notification before consuming the edge", async () => {
    const worktreePath = await createTempDir("ork-electron-local-agent-retry-");
    const environment = createEnvironment({
      id: "env-local-agent-retry",
      worktreePath,
    });
    const { context, emitted } = createContext(environment);
    const recordCompletion = context.storage.recordEnvironmentCompletion as ReturnType<typeof mock>;
    recordCompletion.mockRejectedValueOnce(new Error("storage temporarily unavailable"));
    const notifyAgentTurnCompleted = mock(async (_environmentId: string) => undefined);
    notifyAgentTurnCompleted.mockRejectedValueOnce(new Error("command temporarily unavailable"));
    context.notifyAgentTurnCompleted = notifyAgentTurnCompleted;
    const commands = createCommandRegistry();

    const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      {
        environmentId: environment.id,
        cols: 80,
        rows: 24,
        trackEnvironmentActivity: true,
      },
      context,
    )).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);
    await commands.get("local_terminal_write")?.({ sessionId, data: "codex\r" }, context);
    ptyProcesses[0]?.emitData("done\r\n");

    await waitForCondition(
      () => recordCompletion.mock.calls.length === 2
        && notifyAgentTurnCompleted.mock.calls.length === 2,
      "completion persistence and notification retries",
    );
    expect(emitted.filter(({ event, payload }) =>
      event === "environment-activity-recorded"
      && (payload as { activity_kind?: string }).activity_kind === "completed"
    )).toHaveLength(1);

    ptyProcesses[0]?.emitData("late background output");
    await Bun.sleep(TERMINAL_ACTIVITY_SETTLE_TEST_WAIT_MS);
    expect(recordCompletion).toHaveBeenCalledTimes(2);
    expect(notifyAgentTurnCompleted).toHaveBeenCalledTimes(2);
    await commands.get("close_local_terminal_session")?.({ sessionId }, context);
  }, ASYNC_TEST_BUDGET_MS);

  test("deduplicates settled output per prompt generation and admits the next prompt", async () => {
    const worktreePath = await createTempDir("ork-electron-local-agent-generations-");
    const environment = createEnvironment({ id: "env-local-agent-generations", worktreePath });
    const { context } = createContext(environment);
    let releaseFirst!: () => void;
    const firstNotification = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const notifyAgentTurnCompleted = mock(() =>
      notifyAgentTurnCompleted.mock.calls.length === 1
        ? firstNotification
        : Promise.resolve()
    );
    context.notifyAgentTurnCompleted = notifyAgentTurnCompleted;
    const recordCompletion = context.storage.recordEnvironmentCompletion as ReturnType<typeof mock>;
    const commands = createCommandRegistry();
    const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      {
        environmentId: environment.id,
        cols: 80,
        rows: 24,
        trackEnvironmentActivity: true,
      },
      context,
    )).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);

    await commands.get("local_terminal_write")?.({ sessionId, data: "first\r" }, context);
    ptyProcesses[0]?.emitData("first done\r\n");
    await waitForCondition(() => notifyAgentTurnCompleted.mock.calls.length === 1, "first generation notification");
    ptyProcesses[0]?.emitData("late output from first generation");
    await Bun.sleep(TERMINAL_ACTIVITY_SETTLE_TEST_WAIT_MS);
    expect(recordCompletion).toHaveBeenCalledTimes(1);

    await commands.get("local_terminal_write")?.({ sessionId, data: "second\r" }, context);
    ptyProcesses[0]?.emitData("second done\r\n");
    await waitForCondition(() => notifyAgentTurnCompleted.mock.calls.length === 2, "second generation notification");

    expect(recordCompletion).toHaveBeenCalledTimes(2);
    releaseFirst();
    await commands.get("close_local_terminal_session")?.({ sessionId }, context);
  }, ASYNC_TEST_BUDGET_MS);

  test.each([
    ["persistence", true],
    ["notification", false],
  ] as const)("consumes a tracked terminal edge after %s retry exhaustion", async (_label, failPersistence) => {
    const worktreePath = await createTempDir("ork-electron-local-agent-exhaustion-");
    const environment = createEnvironment({
      id: `env-local-agent-${failPersistence ? "persist" : "notify"}-exhaustion`,
      worktreePath,
    });
    const { context, emitted } = createContext(environment);
    const recordCompletion = context.storage.recordEnvironmentCompletion as ReturnType<typeof mock>;
    const notifyAgentTurnCompleted = mock(async () => undefined);
    if (failPersistence) {
      recordCompletion.mockImplementation(async () => {
        throw new Error("storage permanently unavailable");
      });
    } else {
      notifyAgentTurnCompleted.mockImplementation(async () => {
        throw new Error("notification permanently unavailable");
      });
    }
    context.notifyAgentTurnCompleted = notifyAgentTurnCompleted;
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    const commands = createCommandRegistry();
    try {
      const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
        {
          environmentId: environment.id,
          cols: 80,
          rows: 24,
          trackEnvironmentActivity: true,
        },
        context,
      )).sessionId;
      await commands.get("start_local_terminal_session")?.({ sessionId }, context);
      await commands.get("local_terminal_write")?.({ sessionId, data: "codex\r" }, context);
      ptyProcesses[0]?.emitExit({ exitCode: 0 });

      await waitForCondition(
        () => (failPersistence ? recordCompletion : notifyAgentTurnCompleted).mock.calls.length === 4,
        `${_label} retries to exhaust`,
      );
      const recordsAfterExhaustion = recordCompletion.mock.calls.length;
      const notificationsAfterExhaustion = notifyAgentTurnCompleted.mock.calls.length;
      ptyProcesses[0]?.emitData("stray output after exhausted completion");
      await Bun.sleep(TERMINAL_ACTIVITY_SETTLE_TEST_WAIT_MS);

      expect(recordCompletion).toHaveBeenCalledTimes(recordsAfterExhaustion);
      expect(notifyAgentTurnCompleted).toHaveBeenCalledTimes(notificationsAfterExhaustion);
      expect(emitted.filter(({ event, payload }) =>
        event === "environment-activity-recorded"
        && (payload as { activity_kind?: string }).activity_kind === "completed"
      )).toHaveLength(failPersistence ? 0 : 1);
      expect(consoleError).toHaveBeenCalledWith(
        failPersistence
          ? "Failed to record terminal environment activity"
          : "Failed to notify terminal agent completion",
        expect.objectContaining({ environmentId: environment.id }),
      );
    } finally {
      consoleError.mockRestore();
    }
  }, ASYNC_TEST_BUDGET_MS);

  test("does not carry a completed turn onto a replacement PTY with the same stable key", async () => {
    const worktreePath = await createTempDir("ork-electron-local-agent-reconnect-");
    const environment = createEnvironment({ id: "env-local-agent-reconnect", worktreePath });
    const { context, emitted } = createContext(environment);
    let releaseNotification!: () => void;
    const notificationGate = new Promise<void>((resolve) => {
      releaseNotification = resolve;
    });
    const notifyAgentTurnCompleted = mock(() => notificationGate);
    context.notifyAgentTurnCompleted = notifyAgentTurnCompleted;
    const recordCompletion = context.storage.recordEnvironmentCompletion as ReturnType<typeof mock>;
    const commands = createCommandRegistry();
    const args = {
      environmentId: environment.id,
      terminalKey: "agent-tab",
      cols: 80,
      rows: 24,
      trackEnvironmentActivity: true,
    };

    const first = terminalSessionResult(await commands.get("create_local_terminal_session")?.(args, context));
    await commands.get("start_local_terminal_session")?.({ sessionId: first.sessionId }, context);
    await commands.get("local_terminal_write")?.({ sessionId: first.sessionId, data: "codex\r" }, context);
    ptyProcesses[0]?.emitExit({ exitCode: 0 });
    await waitForCondition(() => notifyAgentTurnCompleted.mock.calls.length === 1, "first terminal completion");

    const replacement = terminalSessionResult(await commands.get("create_local_terminal_session")?.(args, context));
    expect(replacement).toEqual({ sessionId: first.sessionId, created: false });
    await commands.get("start_local_terminal_session")?.({ sessionId: replacement.sessionId }, context);
    ptyProcesses[1]?.emitData("$ ");
    await Bun.sleep(TERMINAL_ACTIVITY_SETTLE_TEST_WAIT_MS);

    expect(recordCompletion).toHaveBeenCalledTimes(1);
    expect(notifyAgentTurnCompleted).toHaveBeenCalledTimes(1);
    expect(emitted.filter(({ event, payload }) =>
      event === "environment-activity-recorded"
      && (payload as { activity_kind?: string }).activity_kind === "completed"
    )).toHaveLength(1);
    releaseNotification();
    await commands.get("close_local_terminal_session")?.({ sessionId: replacement.sessionId }, context);
  }, ASYNC_TEST_BUDGET_MS);

  test("cancels a tracked terminal completion retry when its environment is deleted", async () => {
    const worktreePath = await createTempDir("ork-electron-local-agent-delete-");
    const environment = createEnvironment({ id: "env-local-agent-delete", worktreePath });
    const { context, emitted } = createContext(environment);
    const recordCompletion = context.storage.recordEnvironmentCompletion as ReturnType<typeof mock>;
    recordCompletion.mockRejectedValueOnce(new Error("storage temporarily unavailable"));
    const notifyAgentTurnCompleted = mock(async () => undefined);
    context.notifyAgentTurnCompleted = notifyAgentTurnCompleted;
    const commands = createCommandRegistry();

    const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      {
        environmentId: environment.id,
        terminalKey: "agent-tab",
        cols: 80,
        rows: 24,
        trackEnvironmentActivity: true,
      },
      context,
    )).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);
    await commands.get("local_terminal_write")?.({ sessionId, data: "codex\r" }, context);
    ptyProcesses[0]?.emitData("done\r\n");
    await waitForCondition(() => recordCompletion.mock.calls.length === 1, "first failed completion write");

    await commands.get("delete_environment")?.({ environmentId: environment.id }, context);
    await Bun.sleep(900);

    expect(recordCompletion).toHaveBeenCalledTimes(1);
    expect(notifyAgentTurnCompleted).not.toHaveBeenCalled();
    expect(emitted.some(({ event, payload }) =>
      event === "environment-activity-recorded"
      && (payload as { activity_kind?: string }).activity_kind === "completed"
    )).toBe(false);
  }, ASYNC_TEST_BUDGET_MS);

  test("debounces repeated output and ignores writes without a submitted prompt", async () => {
    const worktreePath = await createTempDir("ork-electron-local-agent-debounce-");
    const environment = createEnvironment({
      id: "env-local-agent-debounce",
      worktreePath,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const recordActivity = context.storage.recordEnvironmentActivity as ReturnType<typeof mock>;
    const recordCompletion = context.storage.recordEnvironmentCompletion as ReturnType<typeof mock>;

    const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      {
        environmentId: environment.id,
        cols: 80,
        rows: 24,
        trackEnvironmentActivity: true,
      },
      context,
    )).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);

    await commands.get("local_terminal_write")?.({ sessionId, data: "unfinished" }, context);
    ptyProcesses[0]?.emitData("shell echo");
    await Bun.sleep(TERMINAL_ACTIVITY_SETTLE_TEST_WAIT_MS);
    expect(recordActivity).not.toHaveBeenCalled();

    await commands.get("local_terminal_write")?.({ sessionId, data: "\r" }, context);
    expect(recordActivity).toHaveBeenCalledTimes(1);
    recordActivity.mockClear();

    ptyProcesses[0]?.emitData("first chunk");
    await Bun.sleep(400);
    ptyProcesses[0]?.emitData("second chunk");
    // The second chunk restarts the 750ms settle window, so nothing may have been
    // recorded 500ms later. This sleep is load-bearing: it is the reset itself
    // being asserted, and it leaves 250ms of slack against a stalled machine.
    await Bun.sleep(500);
    expect(recordCompletion).not.toHaveBeenCalled();

    // Wait for the restarted window to elapse rather than sleeping exactly past
    // it, so a scheduling stall delays the test instead of failing it.
    await waitForCondition(
      () => recordCompletion.mock.calls.length > 0,
      "debounced terminal completion to settle",
    );
    expect(recordCompletion).toHaveBeenCalledTimes(1);
    recordCompletion.mockClear();
    ptyProcesses[0]?.emitData("background output after completion");
    await Bun.sleep(TERMINAL_ACTIVITY_SETTLE_TEST_WAIT_MS);
    expect(recordCompletion).not.toHaveBeenCalled();
    await commands.get("close_local_terminal_session")?.({ sessionId }, context);
  }, ASYNC_TEST_BUDGET_MS);

  test("logs terminal activity persistence failures without emitting a success event", async () => {
    const worktreePath = await createTempDir("ork-electron-local-agent-persistence-failure-");
    const environment = createEnvironment({
      id: "env-local-agent-persistence-failure",
      worktreePath,
    });
    const { context, emitted } = createContext(environment);
    const commands = createCommandRegistry();
    const persistenceError = new Error("activity storage unavailable");
    const recordActivity = context.storage.recordEnvironmentActivity as ReturnType<typeof mock>;
    recordActivity.mockRejectedValueOnce(persistenceError);
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
        {
          environmentId: environment.id,
          cols: 80,
          rows: 24,
          trackEnvironmentActivity: true,
        },
        context,
      )).sessionId;
      await commands.get("start_local_terminal_session")?.({ sessionId }, context);
      await commands.get("local_terminal_write")?.({ sessionId, data: "codex\r" }, context);

      await waitForCondition(
        () => consoleError.mock.calls.length > 0,
        "the terminal activity persistence error",
      );
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to record terminal environment activity",
        {
          environmentId: environment.id,
          error: persistenceError.message,
        },
      );
      expect(emitted.some(({ event }) => event === "environment-activity-recorded")).toBe(false);
      await commands.get("close_local_terminal_session")?.({ sessionId }, context);
    } finally {
      consoleError.mockRestore();
    }
  }, ASYNC_TEST_BUDGET_MS);

  test("cancels pending settled-output activity when a tracked terminal is explicitly closed", async () => {
    const worktreePath = await createTempDir("ork-electron-local-agent-close-");
    const environment = createEnvironment({
      id: "env-local-agent-close",
      worktreePath,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const recordActivity = context.storage.recordEnvironmentActivity as ReturnType<typeof mock>;
    const recordCompletion = context.storage.recordEnvironmentCompletion as ReturnType<typeof mock>;

    const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      {
        environmentId: environment.id,
        cols: 80,
        rows: 24,
        trackEnvironmentActivity: true,
      },
      context,
    )).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);
    await commands.get("local_terminal_write")?.({ sessionId, data: "claude\r" }, context);
    recordActivity.mockClear();

    ptyProcesses[0]?.emitData("work in progress");
    await commands.get("close_local_terminal_session")?.({ sessionId }, context);
    await Bun.sleep(TERMINAL_ACTIVITY_SETTLE_TEST_WAIT_MS);

    expect(recordActivity).not.toHaveBeenCalled();
    expect(recordCompletion).not.toHaveBeenCalled();
    expect(ptyProcesses[0]?.kill).toHaveBeenCalled();
  });

  test("records prompt and settled-output activity for tracked container agent terminals", async () => {
    const environment = createEnvironment({
      id: "env-container-agent-activity",
      environmentType: "containerized",
      containerId: "container-activity",
      worktreePath: undefined,
      lastActivityAt: "2026-07-23T09:00:00.000Z",
    });
    const { context } = createContext(environment);
    const notifyAgentTurnCompleted = mock(async (_environmentId: string) => undefined);
    context.notifyAgentTurnCompleted = notifyAgentTurnCompleted;
    const commands = createCommandRegistry();
    const recordActivity = context.storage.recordEnvironmentActivity as ReturnType<typeof mock>;
    const recordCompletion = context.storage.recordEnvironmentCompletion as ReturnType<typeof mock>;

    const sessionId = terminalSessionResult(await commands.get("create_terminal_session")?.(
      {
        containerId: environment.containerId,
        cols: 80,
        rows: 24,
        trackEnvironmentActivity: true,
      },
      context,
    )).sessionId;
    await commands.get("start_terminal_session")?.({ sessionId }, context);

    await withFixedDate("2026-07-23T11:00:00.000Z", () =>
      commands.get("terminal_write")?.({ sessionId, data: "codex\r" }, context),
    );
    await withFixedDate("2026-07-23T11:02:00.000Z", () => {
      ptyProcesses[0]?.emitData("waiting for input\r\n");
      ptyProcesses[0]?.emitExit({ exitCode: 0 });
    });

    expect(recordActivity).toHaveBeenCalledWith(
      environment.id,
      "2026-07-23T11:00:00.000Z",
    );
    expect(recordCompletion).toHaveBeenCalledWith(
      environment.id,
      "2026-07-23T11:02:00.000Z",
    );
    await waitForCondition(
      () => notifyAgentTurnCompleted.mock.calls.length === 1,
      "the container terminal completion notification",
    );
    expect(notifyAgentTurnCompleted).toHaveBeenCalledWith(environment.id);
    expect(environment.hasUnreadWork).toBe(true);
    expect(environment.lastActivityAt).toBe("2026-07-23T11:02:00.000Z");
  });

  test("rejects activity tracking for a container outside the stored environment set", async () => {
    const environment = createEnvironment({
      id: "env-known-container",
      environmentType: "containerized",
      containerId: "container-known",
      worktreePath: undefined,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await expect(commands.get("create_terminal_session")?.(
      {
        containerId: "container-unrelated",
        cols: 80,
        rows: 24,
        trackEnvironmentActivity: true,
      },
      context,
    )).rejects.toThrow("Tracked terminal container is not associated with an environment");

    await expect(commands.get("create_terminal_session")?.(
      {
        containerId: "container-unrelated",
        environmentId: environment.id,
        terminalKey: "plain-tab",
        cols: 80,
        rows: 24,
      },
      context,
    )).rejects.toThrow("Terminal container is not associated with the requested environment");
  });

  test("does not record shell activity for untracked terminal tabs", async () => {
    const worktreePath = await createTempDir("ork-electron-untracked-terminal-");
    const environment = createEnvironment({ id: "env-untracked-terminal", worktreePath });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const recordActivity = context.storage.recordEnvironmentActivity as ReturnType<typeof mock>;
    const recordCompletion = context.storage.recordEnvironmentCompletion as ReturnType<typeof mock>;

    const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      { environmentId: environment.id, cols: 80, rows: 24 },
      context,
    )).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);
    await commands.get("local_terminal_write")?.({ sessionId, data: "pwd\r" }, context);
    ptyProcesses[0]?.emitData("/tmp/worktree\r\n");
    ptyProcesses[0]?.emitExit({ exitCode: 0 });

    expect(recordActivity).not.toHaveBeenCalled();
    expect(recordCompletion).not.toHaveBeenCalled();
  });

  test("rejects local terminal start when the worktree path is missing", async () => {
    const missingWorktreePath = path.join(os.tmpdir(), `ork-missing-worktree-${Date.now()}`);
    const environment = createEnvironment({ worktreePath: missingWorktreePath });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      { environmentId: environment.id, cols: 80, rows: 24 },
      context,
    )).sessionId;

    await expect(commands.get("start_local_terminal_session")?.({ sessionId }, context)).rejects.toThrow(
      `Local environment worktree does not exist: ${missingWorktreePath}`,
    );
    expect(ptySpawn).not.toHaveBeenCalled();
  });

  test("starts legacy terminal session identifiers without a remembered config", async () => {
    const worktreePath = await createTempDir("ork-electron-legacy-terminal-");
    const environment = createEnvironment({
      id: "env-legacy-terminal",
      worktreePath,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const localSessionId = `${environment.id}:legacy-local`;
    const containerSessionId = "container-legacy:legacy-container";

    await commands.get("start_local_terminal_session")?.(
      { sessionId: localSessionId },
      context,
    );
    await commands.get("start_terminal_session")?.(
      { sessionId: containerSessionId },
      context,
    );

    expect(ptySpawn.mock.calls[0]?.[0]).toBe(expectedLocalShellPath());
    expect(ptySpawn.mock.calls[0]?.[2]).toMatchObject({
      cwd: worktreePath,
      cols: 80,
      rows: 24,
    });
    expect(ptySpawn.mock.calls[1]?.[0]).toBe("docker");
    expect(ptySpawn.mock.calls[1]?.[1]).toEqual([
      "exec",
      "-it",
      "container-legacy",
      "bash",
      "-lc",
      [
        "source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true",
        "orkestrator_source_runtime_env 2>/dev/null || true",
        "exec zsh -l",
      ].join("\n"),
    ]);
  });

  test("verifies, stores, and disconnects Linear auth through command handlers", async () => {
    const originalFetch = globalThis.fetch;
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();
    let auth: { apiKey: string; viewer?: { id: string; name: string; email?: string } } | null = null;

    Object.assign(context.storage, {
      getLinearAuth: mock(async () => auth),
      saveLinearAuth: mock(async (apiKey: string, viewer?: { id: string; name: string; email?: string }) => {
        auth = { apiKey, viewer };
        return auth;
      }),
      clearLinearAuth: mock(async () => {
        auth = null;
      }),
    });

    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "lin_api_secret" });
      return new Response(JSON.stringify({
        data: {
          viewer: { id: "viewer-1", name: "Ada", email: "ada@example.com" },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    try {
      await expect(commands.get("get_linear_connection")?.({}, context)).resolves.toEqual({
        connected: false,
        hasToken: false,
      });

      await expect(commands.get("connect_linear")?.({ apiKey: " lin_api_secret " }, context)).resolves.toEqual({
        connected: true,
        hasToken: true,
        viewer: { id: "viewer-1", name: "Ada", email: "ada@example.com" },
      });
      expect(auth?.apiKey).toBe("lin_api_secret");

      await expect(commands.get("get_linear_connection")?.({}, context)).resolves.toEqual({
        connected: true,
        hasToken: true,
        viewer: { id: "viewer-1", name: "Ada", email: "ada@example.com" },
      });

      await expect(commands.get("disconnect_linear")?.({}, context)).resolves.toEqual({
        connected: false,
        hasToken: false,
      });
      expect(auth).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("posts Linear issue comments through command handlers", async () => {
    const originalFetch = globalThis.fetch;
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();

    Object.assign(context.storage, {
      getLinearAuth: mock(async () => ({ apiKey: "lin_api_secret" })),
    });

    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> };
      expect(init?.headers).toMatchObject({ Authorization: "lin_api_secret" });
      expect(request.query).toContain("OrkestratorLinearIssueComment");
      expect(request.variables).toMatchObject({
        issueId: "issue-1",
        body: "Looks good",
      });
      return new Response(JSON.stringify({
        data: {
          commentCreate: {
            success: true,
            comment: {
              id: "comment-1",
              body: "Looks good",
              createdAt: "2026-06-28T12:10:00.000Z",
              updatedAt: "2026-06-28T12:10:00.000Z",
              user: { name: "Ada" },
            },
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    try {
      await expect(commands.get("post_linear_issue_comment")?.({
        issueId: "issue-1",
        body: " Looks good ",
      }, context)).resolves.toEqual({
        id: "comment-1",
        body: "Looks good",
        createdAt: "2026-06-28T12:10:00.000Z",
        updatedAt: "2026-06-28T12:10:00.000Z",
        authorName: "Ada",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("serializes concurrent Linear completion comments by pipeline ID", async () => {
    const originalFetch = globalThis.fetch;
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();
    let completionRecord: {
      pipelineId: string;
      issueId: string;
      status: "posted" | "failed";
      commentId?: string;
      postedAt?: string;
      error?: string;
    } | null = null;
    let commentCreateCalls = 0;

    Object.assign(context.storage, {
      getLinearAuth: mock(async () => ({ apiKey: "lin_api_secret" })),
      getLinearCompletionComment: mock(async () => completionRecord),
      saveLinearCompletionComment: mock(async (record: typeof completionRecord) => {
        completionRecord = record;
        return record;
      }),
    });

    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query: string };
      if (request.query.includes("OrkestratorLinearCompletionComments")) {
        return new Response(JSON.stringify({
          data: {
            issue: {
              comments: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      commentCreateCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return new Response(JSON.stringify({
        data: {
          commentCreate: {
            success: true,
            comment: { id: "comment-1", createdAt: "2026-06-28T12:00:00.000Z" },
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    try {
      const [first, second] = await Promise.all([
        commands.get("post_linear_completion_comment")?.({
          pipelineId: "pipeline-1",
          issueId: "issue-1",
          body: "Done",
        }, context),
        commands.get("post_linear_completion_comment")?.({
          pipelineId: "pipeline-1",
          issueId: "issue-1",
          body: "Done",
        }, context),
      ]);

      expect(commentCreateCalls).toBe(1);
      expect(first).toEqual({
        status: "posted",
        commentId: "comment-1",
        postedAt: "2026-06-28T12:00:00.000Z",
      });
      expect(second).toEqual({
        status: "already-posted",
        commentId: "comment-1",
        postedAt: "2026-06-28T12:00:00.000Z",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not retry queued concurrent Linear completion comments after a failure", async () => {
    const originalFetch = globalThis.fetch;
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();
    let completionRecord: {
      pipelineId: string;
      issueId: string;
      status: "posted" | "failed";
      commentId?: string;
      postedAt?: string;
      error?: string;
    } | null = null;
    let commentCreateCalls = 0;

    Object.assign(context.storage, {
      getLinearAuth: mock(async () => ({ apiKey: "lin_api_secret" })),
      getLinearCompletionComment: mock(async () => completionRecord),
      saveLinearCompletionComment: mock(async (record: typeof completionRecord) => {
        completionRecord = record;
        return record;
      }),
    });

    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query: string };
      if (request.query.includes("OrkestratorLinearCompletionComments")) {
        return new Response(JSON.stringify({
          data: {
            issue: {
              comments: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      commentCreateCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return new Response(JSON.stringify({
        errors: [{ message: "Linear unavailable" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    try {
      const [first, second] = await Promise.allSettled([
        commands.get("post_linear_completion_comment")?.({
          pipelineId: "pipeline-1",
          issueId: "issue-1",
          body: "Done",
        }, context),
        commands.get("post_linear_completion_comment")?.({
          pipelineId: "pipeline-1",
          issueId: "issue-1",
          body: "Done",
        }, context),
      ]);

      expect(commentCreateCalls).toBe(1);
      expect(first.status).toBe("rejected");
      expect(second.status).toBe("rejected");
      if (first.status === "rejected") expect(first.reason.message).toBe("Linear unavailable");
      if (second.status === "rejected") expect(second.reason.message).toBe("Linear unavailable");
      expect(completionRecord).toMatchObject({
        pipelineId: "pipeline-1",
        issueId: "issue-1",
        status: "failed",
        error: "Linear unavailable",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("serializes and persists idempotent GitHub completion comments", async () => {
    const originalFetch = globalThis.fetch;
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();
    let completionRecord: {
      pipelineId: string;
      repositoryOwner: string;
      repositoryName: string;
      issueNumber: number;
      status: "posted" | "failed";
      commentId?: string;
      postedAt?: string;
      error?: string;
    } | null = null;
    let commentCreateCalls = 0;

    Object.assign(context.storage, {
      loadConfig: mock(async () => ({
        version: "1.0.0",
        global: { githubToken: "github_secret_token" },
        repositories: {},
      })),
      getGitHubCompletionComment: mock(async () => completionRecord),
      saveGitHubCompletionComment: mock(async (record: typeof completionRecord) => {
        completionRecord = record;
        return record;
      }),
    });

    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      commentCreateCalls += 1;
      const payload = JSON.parse(String(init?.body)) as { body: string };
      expect(payload.body).toContain("<!-- orkestrator-github-run:pipeline-github -->");
      await new Promise((resolve) => setTimeout(resolve, 25));
      return new Response(JSON.stringify({
        id: 9001,
        body: payload.body,
        html_url: "https://github.com/acme/widget/issues/42#issuecomment-9001",
        created_at: "2026-07-24T12:00:00.000Z",
        updated_at: "2026-07-24T12:00:00.000Z",
        user: { login: "ork-user" },
      }), { status: 201, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const args = {
      pipelineId: "pipeline-github",
      projectId: "project-1",
      repositoryOwner: "acme",
      repositoryName: "project",
      issueNumber: 42,
      body: "Result: Complete",
    };
    try {
      const [first, second] = await Promise.all([
        commands.get("post_github_completion_comment")?.(args, context),
        commands.get("post_github_completion_comment")?.(args, context),
      ]);

      expect(commentCreateCalls).toBe(1);
      expect(first).toEqual({
        status: "posted",
        commentId: "9001",
        postedAt: "2026-07-24T12:00:00.000Z",
      });
      expect(second).toEqual({
        status: "already-posted",
        commentId: "9001",
        postedAt: "2026-07-24T12:00:00.000Z",
      });
      expect(completionRecord).toMatchObject({
        pipelineId: "pipeline-github",
        repositoryOwner: "acme",
        repositoryName: "project",
        issueNumber: 42,
        status: "posted",
        commentId: "9001",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("recovers a GitHub completion comment accepted before local persistence", async () => {
    const originalFetch = globalThis.fetch;
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();
    let completionRecord: Record<string, unknown> | null = {
      pipelineId: "pipeline-retry",
      repositoryOwner: "acme",
      repositoryName: "project",
      issueNumber: 42,
      status: "failed",
      error: "Connection reset",
    };
    let commentCreateCalls = 0;

    Object.assign(context.storage, {
      loadConfig: mock(async () => ({
        version: "1.0.0",
        global: { githubToken: "github_secret_token" },
        repositories: {},
      })),
      getGitHubCompletionComment: mock(async () => completionRecord),
      saveGitHubCompletionComment: mock(async (record: Record<string, unknown>) => {
        completionRecord = record;
        return record;
      }),
    });
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") !== "GET") commentCreateCalls += 1;
      return new Response(JSON.stringify([{
        id: 9002,
        body: "Done\n\n<!-- orkestrator-github-run:pipeline-retry -->",
        html_url: "https://github.com/acme/widget/issues/42#issuecomment-9002",
        created_at: "2026-07-24T12:05:00.000Z",
        updated_at: "2026-07-24T12:05:00.000Z",
        user: { login: "ork-user" },
      }]), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    try {
      await expect(commands.get("post_github_completion_comment")?.({
        pipelineId: "pipeline-retry",
        projectId: "project-1",
        repositoryOwner: "acme",
        repositoryName: "project",
        issueNumber: 42,
        body: "Result: Complete",
      }, context)).resolves.toEqual({
        status: "already-posted",
        commentId: "9002",
        postedAt: "2026-07-24T12:05:00.000Z",
      });
      expect(commentCreateCalls).toBe(0);
      expect(completionRecord).toMatchObject({
        status: "posted",
        commentId: "9002",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("persists a sanitized GitHub completion API failure for retry", async () => {
    const originalFetch = globalThis.fetch;
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();
    const secret = "github_secret_token";
    let completionRecord: Record<string, unknown> | null = null;

    Object.assign(context.storage, {
      loadConfig: mock(async () => ({
        version: "1.0.0",
        global: { githubToken: secret },
        repositories: {},
      })),
      getGitHubCompletionComment: mock(async () => completionRecord),
      saveGitHubCompletionComment: mock(async (record: Record<string, unknown>) => {
        completionRecord = record;
        return record;
      }),
    });
    globalThis.fetch = mock(async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      if ((init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        message: `Forbidden for Bearer ${secret}`,
      }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      await expect(commands.get("post_github_completion_comment")?.({
        pipelineId: "pipeline-failed",
        projectId: "project-1",
        repositoryOwner: "acme",
        repositoryName: "project",
        issueNumber: 42,
        body: "Result: Failed",
      }, context)).rejects.toThrow("GitHub denied permission");
      expect(completionRecord).toMatchObject({
        pipelineId: "pipeline-failed",
        repositoryOwner: "acme",
        repositoryName: "project",
        issueNumber: 42,
        status: "failed",
      });
      expect(String(completionRecord?.error)).toContain("Issues write access");
      expect(JSON.stringify(completionRecord)).not.toContain(secret);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects a GitHub completion target outside the selected project repository", async () => {
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();
    const getCompletion = mock(async () => null);
    Object.assign(context.storage, {
      loadConfig: mock(async () => ({
        version: "1.0.0",
        global: { githubToken: "github_secret_token" },
        repositories: {},
      })),
      getGitHubCompletionComment: getCompletion,
    });

    await expect(commands.get("post_github_completion_comment")?.({
      pipelineId: "pipeline-out-of-scope",
      projectId: "project-1",
      repositoryOwner: "other",
      repositoryName: "repository",
      issueNumber: 1,
      body: "Result: Complete",
    }, context)).rejects.toThrow("does not match the selected project");
    expect(getCompletion).not.toHaveBeenCalled();
  });

  test("starts container terminal sessions through docker exec in a PTY", async () => {
    const environment = createEnvironment({
      id: "env-container-terminal",
      environmentType: "containerized",
      containerId: "container-1",
      worktreePath: undefined,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const createArgs = {
      containerId: "container-1",
      environmentId: environment.id,
      terminalKey: "root-tab",
      cols: 100,
      rows: 32,
      user: "node",
    };

    const firstResult = terminalSessionResult(await commands.get("create_terminal_session")?.(
      createArgs,
      context,
    ));
    const sessionId = firstResult.sessionId;
    expect(firstResult.created).toBe(true);
    await commands.get("start_terminal_session")?.({ sessionId }, context);
    const reattachedResult = terminalSessionResult(await commands.get("create_terminal_session")?.(
      createArgs,
      context,
    ));
    const reattachedSessionId = reattachedResult.sessionId;
    expect(reattachedResult.created).toBe(false);
    await commands.get("start_terminal_session")?.(
      { sessionId: reattachedSessionId },
      context,
    );

    const spawnCall = ptySpawn.mock.calls[0];
    expect(reattachedSessionId).toBe(sessionId);
    expect(ptySpawn).toHaveBeenCalledTimes(1);
    expect(spawnCall?.[0]).toBe("docker");
    expect(spawnCall?.[1]).toEqual([
      "exec",
      "-it",
      "--user",
      "node",
      "container-1",
      "bash",
      "-lc",
      expect.stringContaining("orkestrator_source_runtime_env"),
    ]);
    expect(spawnCall?.[2]).toMatchObject({
      cols: 100,
      rows: 32,
    });
  });

  test("supersedes a stable container terminal when its target or activity context changes", async () => {
    const environment = createEnvironment({
      id: "env-container-terminal-replaced",
      environmentType: "containerized",
      containerId: "container-old",
      worktreePath: undefined,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const baseArgs = {
      environmentId: environment.id,
      terminalKey: "root-tab",
      cols: 100,
      rows: 32,
    };

    const first = terminalSessionResult(await commands.get("create_terminal_session")?.(
      { ...baseArgs, containerId: "container-old", user: "node" },
      context,
    ));
    await commands.get("start_terminal_session")?.({ sessionId: first.sessionId }, context);

    environment.containerId = "container-new";
    const changedContainer = terminalSessionResult(await commands.get("create_terminal_session")?.(
      { ...baseArgs, containerId: "container-new", user: "node" },
      context,
    ));
    expect(changedContainer.created).toBe(true);
    expect(changedContainer.sessionId).not.toBe(first.sessionId);
    expect(ptyProcesses[0]?.kill).toHaveBeenCalledTimes(1);
    await commands.get("start_terminal_session")?.(
      { sessionId: changedContainer.sessionId },
      context,
    );
    expect(ptySpawn.mock.calls[1]?.[1]).toEqual([
      "exec",
      "-it",
      "--user",
      "node",
      "container-new",
      "bash",
      "-lc",
      expect.stringContaining("orkestrator_source_runtime_env"),
    ]);

    const changedUser = terminalSessionResult(await commands.get("create_terminal_session")?.(
      { ...baseArgs, containerId: "container-new", user: "root" },
      context,
    ));
    expect(changedUser.created).toBe(true);
    expect(changedUser.sessionId).not.toBe(changedContainer.sessionId);
    expect(ptyProcesses[1]?.kill).toHaveBeenCalledTimes(1);

    const changedActivity = terminalSessionResult(await commands.get("create_terminal_session")?.(
      {
        ...baseArgs,
        containerId: "container-new",
        user: "root",
        trackEnvironmentActivity: true,
      },
      context,
    ));
    expect(changedActivity.created).toBe(true);
    expect(changedActivity.sessionId).not.toBe(changedUser.sessionId);
  });

  test("does not start a container terminal after its stable session is superseded during lookup", async () => {
    const environment = createEnvironment({
      id: "env-container-terminal-start-replaced",
      environmentType: "containerized",
      containerId: "container-1",
      worktreePath: undefined,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const baseArgs = {
      containerId: "container-1",
      environmentId: environment.id,
      terminalKey: "root-tab",
      cols: 100,
      rows: 32,
    };
    const first = terminalSessionResult(await commands.get("create_terminal_session")?.(
      { ...baseArgs, user: "node" },
      context,
    ));
    const originalGetEnvironment = context.storage.getEnvironment.bind(context.storage);
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    let lookupStarted = false;
    context.storage.getEnvironment = mock(async (environmentId) => {
      lookupStarted = true;
      await lookupGate;
      return originalGetEnvironment(environmentId);
    });

    const startPromise = commands.get("start_terminal_session")?.(
      { sessionId: first.sessionId },
      context,
    ) as Promise<void>;
    await waitForCondition(() => lookupStarted, "the container terminal environment lookup");

    const replacement = terminalSessionResult(await commands.get("create_terminal_session")?.(
      { ...baseArgs, user: "root" },
      context,
    ));
    releaseLookup();

    await expect(startPromise).rejects.toThrow("Container terminal session is no longer available");
    expect(replacement.sessionId).not.toBe(first.sessionId);
    expect(ptySpawn).not.toHaveBeenCalled();

    commands.get("detach_terminal")?.({ sessionId: replacement.sessionId }, context);
  }, ASYNC_TEST_BUDGET_MS);
});

describe("GitHub issue commands", () => {
  test("loads and mutates only the selected project's GitHub issues", async () => {
    const originalFetch = globalThis.fetch;
    const { context } = createContext(createEnvironment(), {
      project: {
        id: "project-1",
        name: "repo",
        gitUrl: "https://github.com/acme/repo.git",
        localPath: null,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
    });
    const commands = createCommandRegistry();
    const requests: Array<{ method: string; pathname: string; body: unknown }> = [];
    let issueTitle = "Original issue";
    let issueBody = "Original body";
    let issueState = "open";
    let issueLabels = [{ name: "bug", color: "ff0000" }];
    let commentBody = "Original comment";

    Object.assign(context.storage, {
      loadConfig: mock(async () => ({
        version: "1.0.0",
        global: { githubToken: "github_secret_token" },
        repositories: {},
      })),
    });

    const issuePayload = () => ({
      id: 420,
      number: 42,
      title: issueTitle,
      body: issueBody,
      html_url: "https://github.com/acme/repo/issues/42",
      state: issueState,
      locked: false,
      user: {
        login: "viewer",
        avatar_url: "https://avatars.example/viewer",
        html_url: "https://github.com/viewer",
      },
      assignees: [],
      labels: issueLabels,
      comments: 1,
      created_at: "2026-07-20T10:00:00.000Z",
      updated_at: "2026-07-24T10:00:00.000Z",
    });
    const commentPayload = () => ({
      id: 7,
      body: commentBody,
      html_url: "https://github.com/acme/repo/issues/42#issuecomment-7",
      issue_url: "https://api.github.com/repos/acme/repo/issues/42",
      user: { login: "viewer" },
      created_at: "2026-07-21T10:00:00.000Z",
      updated_at: "2026-07-21T10:00:00.000Z",
    });

    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ method, pathname: `${url.pathname}${url.search}`, body });
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer github_secret_token");

      if (url.pathname === "/user") {
        return Response.json({ login: "viewer", html_url: "https://github.com/viewer" });
      }
      if (url.pathname === "/repos/acme/repo") {
        return Response.json({
          full_name: "acme/repo",
          html_url: "https://github.com/acme/repo",
          permissions: { push: false },
        });
      }
      if (url.pathname === "/repos/acme/repo/labels" && method === "GET") {
        return Response.json([
          { name: "ork:todo", color: "D4C5F9" },
          { name: "ork:inprogress", color: "FBCA04" },
          { name: "ork:review", color: "0E8A16" },
        ]);
      }
      if (url.pathname === "/repos/acme/repo/issues" && method === "GET") {
        return Response.json([issuePayload()]);
      }
      if (url.pathname === "/repos/acme/repo/issues/42/comments" && method === "GET") {
        return Response.json([commentPayload()]);
      }
      if (url.pathname === "/repos/acme/repo/issues/42/comments" && method === "POST") {
        commentBody = String((body as { body: string }).body);
        return Response.json(commentPayload(), { status: 201 });
      }
      if (url.pathname === "/repos/acme/repo/issues/comments/7" && method === "GET") {
        return Response.json(commentPayload());
      }
      if (url.pathname === "/repos/acme/repo/issues/comments/7" && method === "PATCH") {
        commentBody = String((body as { body: string }).body);
        return Response.json({ ...commentPayload(), updated_at: "2026-07-24T11:00:00.000Z" });
      }
      if (url.pathname.startsWith("/repos/acme/repo/issues/42/labels/") && method === "DELETE") {
        const label = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        issueLabels = issueLabels.filter((candidate) => candidate.name !== label);
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/repos/acme/repo/issues/42/labels" && method === "POST") {
        const labels = (body as { labels: string[] }).labels;
        issueLabels = [
          ...issueLabels,
          ...labels.map((name) => ({ name, color: "D4C5F9" })),
        ];
        return Response.json(issueLabels);
      }
      if (url.pathname === "/repos/acme/repo/issues/42" && method === "PATCH") {
        const update = body as { title?: string; body?: string; state?: string };
        if (update.title !== undefined) issueTitle = update.title;
        if (update.body !== undefined) issueBody = update.body;
        if (update.state !== undefined) issueState = update.state;
        return Response.json(issuePayload());
      }
      if (url.pathname === "/repos/acme/repo/issues/42" && method === "GET") {
        return Response.json(issuePayload());
      }
      throw new Error(`Unexpected GitHub request: ${method} ${url.pathname}${url.search}`);
    }) as unknown as typeof fetch;

    try {
      const snapshot = await commands.get("get_github_issues")?.({ projectId: "project-1" }, context);
      expect(snapshot).toMatchObject({
        repository: { owner: "acme", name: "repo" },
        viewer: { login: "viewer" },
        issues: [{ number: 42, title: "Original issue", status: "backlog" }],
      });
      await expect(commands.get("get_github_issue")?.({
        projectId: "project-1",
        issueNumber: 42,
      }, context)).resolves.toMatchObject({
        number: 42,
        comments: [{ id: 7, body: "Original comment", canEdit: true }],
      });
      await expect(commands.get("update_github_issue")?.({
        projectId: "project-1",
        issueNumber: 42,
        title: "Updated issue",
        body: "Updated body",
      }, context)).resolves.toMatchObject({ title: "Updated issue", body: "Updated body" });
      const statusIssue = await commands.get("update_github_issue_status")?.({
        projectId: "project-1",
        issueNumber: 42,
        status: "todo",
      }, context) as { status: string; labels: Array<{ name: string }> };
      expect(statusIssue.status).toBe("todo");
      expect(statusIssue.labels.map((label) => label.name)).toEqual(["bug", "ork:todo"]);
      await expect(commands.get("add_github_issue_comment")?.({
        projectId: "project-1",
        issueNumber: 42,
        body: "New comment",
      }, context)).resolves.toMatchObject({ body: "New comment", canEdit: true });
      await expect(commands.get("update_github_issue_comment")?.({
        projectId: "project-1",
        issueNumber: 42,
        commentId: 7,
        body: "Edited comment",
      }, context)).resolves.toMatchObject({ body: "Edited comment", canEdit: true, isEdited: true });
      await expect(commands.get("close_github_issue")?.({
        projectId: "project-1",
        issueNumber: 42,
      }, context)).resolves.toMatchObject({ state: "closed" });

      expect(requests.filter((request) =>
        request.method === "DELETE" && request.pathname.includes("/issues/42/labels/")
      )).toHaveLength(3);
      expect(requests).toContainEqual({
        method: "POST",
        pathname: "/repos/acme/repo/issues/42/labels",
        body: { labels: ["ork:todo"] },
      });
      expect(JSON.stringify(await commands.get("get_github_issues")?.({
        projectId: "project-1",
      }, context))).not.toContain("github_secret_token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reports actionable GitHub setup and sanitized API failures", async () => {
    const commands = createCommandRegistry();
    const { context } = createContext(createEnvironment());

    Object.assign(context.storage, {
      loadConfig: mock(async () => ({ version: "1.0.0", global: {}, repositories: {} })),
    });
    await expect(commands.get("get_github_issues")?.({ projectId: "project-1" }, context))
      .rejects.toThrow("GitHub is not configured");

    Object.assign(context.storage, {
      getProject: mock(async () => null),
      loadConfig: mock(async () => ({
        version: "1.0.0",
        global: { githubToken: "github_secret_token" },
        repositories: {},
      })),
    });
    await expect(commands.get("get_github_issues")?.({ projectId: "missing" }, context))
      .rejects.toThrow("Project not found: missing");

    Object.assign(context.storage, {
      getProject: mock(async () => ({
        id: "project-1",
        name: "bad",
        gitUrl: "https://gitlab.com/acme/repo.git",
      })),
    });
    await expect(commands.get("get_github_issues")?.({ projectId: "project-1" }, context))
      .rejects.toThrow(/github\.com HTTPS or SSH URL/i);

    const originalFetch = globalThis.fetch;
    Object.assign(context.storage, {
      getProject: mock(async () => ({
        id: "project-1",
        name: "repo",
        gitUrl: "git@github.com:acme/repo.git",
      })),
    });
    globalThis.fetch = mock(async () =>
      Response.json(
        { message: "Bad credentials github_secret_token" },
        { status: 401, headers: { "x-ratelimit-remaining": "1" } },
      )
    ) as unknown as typeof fetch;
    try {
      let failure: Error | null = null;
      try {
        await commands.get("get_github_issues")?.({ projectId: "project-1" }, context);
      } catch (error) {
        failure = error as Error;
      }
      expect(failure?.message).toContain("GitHub authentication failed");
      expect(failure?.message).not.toContain("github_secret_token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("environment status and settings commands", () => {
  test("reports Claude credential availability through the credential status handler", async () => {
    const { context } = createContext([]);
    const commands = createCommandRegistry();
    const hasClaudeCredentials = mock(async () => true);
    commands.set("has_claude_credentials", hasClaudeCredentials);

    await expect(commands.get("get_credential_status")?.({}, context)).resolves.toEqual({
      available: true,
      expiresAt: null,
    });
    expect(hasClaudeCredentials).toHaveBeenCalledTimes(1);
  });

  test("preserves an admitted container start while its container is not yet persisted", async () => {
    const environment = createEnvironment({
      id: "env-active-start-status",
      environmentType: "containerized",
      containerId: null,
      status: "stopped",
      setupScriptsComplete: true,
      networkAccessMode: "full",
    });
    const { context, updates } = createContext(environment);
    const updateEnvironment = context.storage.updateEnvironment as ReturnType<typeof mock>;
    const originalImplementation = updateEnvironment.getMockImplementation();
    let announceCreating!: () => void;
    let releaseCreating!: () => void;
    const creatingPersisted = new Promise<void>((resolve) => {
      announceCreating = resolve;
    });
    const creatingRelease = new Promise<void>((resolve) => {
      releaseCreating = resolve;
    });
    updateEnvironment.mockImplementation(async (
      environmentId: string,
      update: Record<string, unknown>,
    ) => {
      const updated = await originalImplementation!(environmentId, update);
      if (update.status === "creating") {
        announceCreating();
        await creatingRelease;
      }
      return updated;
    });
    const commands = createCommandRegistry();

    await withFakeGh("#!/bin/sh\nexit 1\n", async () => {
      await withFakeDocker(`#!/bin/sh
case "$1" in
  create) printf 'container-active-start-status\\n' ;;
  start|exec) exit 0 ;;
esac
`, async () => {
        await commands.get("start_environment_background")?.(
          { environmentId: environment.id },
          context,
        );
        await creatingPersisted;

        await expect(commands.get("get_environments")?.(
          { projectId: environment.projectId },
          context,
        )).resolves.toEqual([
          expect.objectContaining({
            id: environment.id,
            status: "creating",
            containerId: null,
          }),
        ]);
        expect(updatesWithStatus(updates, "stopped")).toHaveLength(0);

        releaseCreating();
        await waitForCondition(
          () => environment.status === "running",
          "active start to finish",
        );
      });
    });
  }, ASYNC_TEST_BUDGET_MS);

  test("preserves a durable lifecycle failure over Docker container state", async () => {
    const environment = createEnvironment({
      id: "env-error-status-authoritative",
      environmentType: "containerized",
      containerId: "container-error-status",
      status: "error",
      lifecycleError: ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.runtimeUnavailable,
    });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "ps" ]; then
  printf 'container-error-status\\trunning\\n'
  exit 0
fi
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
exit 1
`, async ({ all }) => {
      await expect(commands.get("get_environments")?.(
        { projectId: environment.projectId },
        context,
      )).resolves.toEqual([
        expect.objectContaining({
          id: environment.id,
          status: "error",
          lifecycleError: ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.runtimeUnavailable,
        }),
      ]);

      const calls = await fs.readFile(all, "utf8");
      expect(calls).toContain("ps -a");
      expect(calls).not.toContain("inspect -f");
    });
    expect(updates).toHaveLength(0);
  });

  test("synchronizes individual and all stored environment statuses", async () => {
    const local = createEnvironment({ id: "env-local", environmentType: "local", containerId: null });
    const missingContainer = createEnvironment({
      id: "env-missing",
      environmentType: "containerized",
      containerId: "container-missing",
    });
    const { context, updates } = createContext([local, missingContainer]);
    const commands = createCommandRegistry();

    await expect(commands.get("sync_environment_status")?.({ environmentId: local.id }, context)).resolves.toEqual(toClientEnvironment(local));
    await expect(commands.get("sync_environment_status")?.({ environmentId: "unknown" }, context))
      .rejects.toThrow("Environment not found: unknown");
    await withFakeDocker(`#!/bin/sh
printf 'Error: No such object: %s\\n' "$4" >&2
exit 1
`, async () => {
      await expect(commands.get("sync_all_environments_with_docker")?.({}, context)).resolves.toEqual(["env-missing"]);
    });
    expect(updates).toContainEqual({ status: "stopped", containerId: null });
  });

  test("reconciles container statuses from one labelled docker ps snapshot", async () => {
    const agreeing = createEnvironment({
      id: "env-agree",
      environmentType: "containerized",
      containerId: "container-agree",
      status: "running",
    });
    const transitioned = createEnvironment({
      id: "env-transitioned",
      environmentType: "containerized",
      containerId: "container-transitioned",
      status: "running",
    });
    const { context, updates } = createContext([agreeing, transitioned]);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "ps" ]; then
  printf 'container-agree\\trunning\\n'
  printf 'container-transitioned\\texited\\n'
  exit 0
fi
if [ "$1" = "inspect" ]; then
  printf 'exited\\n'
  exit 0
fi
exit 0
`, async ({ all }) => {
      await commands.get("get_environments")?.({ projectId: agreeing.projectId }, context);
      const log = (await fs.readFile(all, "utf8")).split("\n").filter(Boolean);
      // The whole batch shares one labelled `docker ps` instead of one
      // `docker inspect` per environment.
      expect(log.filter((line) => line.startsWith("ps -a")).length).toBe(1);
      // Only the container whose snapshot state disagrees with storage is
      // confirmed with a fresh inspect before anything is rewritten.
      expect(log.filter((line) => line.startsWith("inspect"))).toEqual([
        "inspect -f {{.State.Status}} container-transitioned",
      ]);
    });

    expect(updates).toEqual([{ status: "stopped" }]);
    expect(agreeing.status).toBe("running");
    expect(transitioned.status).toBe("stopped");
  });

  test("reuses one docker ps snapshot across a burst of status refreshes", async () => {
    const environment = createEnvironment({
      id: "env-burst",
      environmentType: "containerized",
      containerId: "container-burst",
      status: "running",
    });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "ps" ]; then
  printf 'container-burst\\trunning\\n'
  exit 0
fi
exit 1
`, async ({ all }) => {
      await commands.get("get_environments")?.({ projectId: environment.projectId }, context);
      await commands.get("get_environments")?.({ projectId: environment.projectId }, context);
      await expect(commands.get("get_environment_status")?.(
        { environmentId: environment.id },
        context,
      )).resolves.toBe("running");
      const log = (await fs.readFile(all, "utf8")).split("\n").filter(Boolean);
      expect(log.filter((line) => line.startsWith("ps -a")).length).toBe(1);
      expect(log.some((line) => line.startsWith("inspect"))).toBe(false);
    });
    expect(updates).toHaveLength(0);
  });

  test("refreshes the docker ps snapshot after its cache expires", async () => {
    const environment = createEnvironment({
      id: "env-cache-expiry",
      environmentType: "containerized",
      containerId: "container-cache-expiry",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "ps" ]; then
  printf 'container-cache-expiry\\trunning\\n'
  exit 0
fi
exit 1
`, async ({ all }) => {
      await withFixedDate("2026-07-28T12:00:00.000Z", () =>
        commands.get("get_environments")?.({ projectId: environment.projectId }, context)
      );
      await withFixedDate("2026-07-28T12:00:03.001Z", () =>
        commands.get("get_environments")?.({ projectId: environment.projectId }, context)
      );

      const log = (await fs.readFile(all, "utf8")).split("\n").filter(Boolean);
      expect(log.filter((line) => line.startsWith("ps -a"))).toHaveLength(2);
    });
  });

  test("falls back to per-container inspect when the shared docker scan fails", async () => {
    const environment = createEnvironment({
      id: "env-cache-failure",
      environmentType: "containerized",
      containerId: "container-cache-failure",
      status: "running",
    });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "ps" ]; then
  exit 1
fi
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
exit 1
`, async ({ all }) => {
      await commands.get("get_environments")?.(
        { projectId: environment.projectId },
        context,
      );
      const log = (await fs.readFile(all, "utf8")).split("\n").filter(Boolean);
      expect(log.filter((line) => line.startsWith("ps -a"))).toHaveLength(1);
      expect(log.filter((line) => line.startsWith("inspect"))).toEqual([
        "inspect -f {{.State.Status}} container-cache-failure",
      ]);
    });
    expect(updates).toHaveLength(0);
  });

  test("only probes containers missing from the labelled snapshot during full sync", async () => {
    const listed = createEnvironment({
      id: "env-listed",
      environmentType: "containerized",
      containerId: "container-listed",
      status: "running",
    });
    const missing = createEnvironment({
      id: "env-absent",
      environmentType: "containerized",
      containerId: "container-absent",
      status: "running",
    });
    const { context, updates } = createContext([listed, missing]);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "ps" ]; then
  printf 'container-listed\\trunning\\n'
  exit 0
fi
printf 'Error: No such object: container-absent\\n' >&2
exit 1
`, async ({ all }) => {
      await expect(commands.get("sync_all_environments_with_docker")?.({}, context))
        .resolves.toEqual([missing.id]);
      const log = (await fs.readFile(all, "utf8")).split("\n").filter(Boolean);
      expect(log.filter((line) => line.startsWith("ps -a")).length).toBe(1);
      expect(log.filter((line) => line.startsWith("inspect"))).toEqual([
        "inspect -f {{.State.Status}} container-absent",
      ]);
    });
    expect(updates).toEqual([{ status: "stopped", containerId: null }]);
  });

  test("stops local and container environments and treats recreation without a container as a no-op", async () => {
    const local = createEnvironment({
      id: "env-local",
      environmentType: "local",
      containerId: null,
      pendingAgentLaunch: true,
      initialAgentModel: "claude-fable-5[1m]",
      initialReasoningEffort: "max",
    });
    const container = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      pendingAgentLaunch: true,
      initialAgentModel: "gpt-5.6-sol",
      initialReasoningEffort: "high",
      initialPromptAttachments: [{
        id: "attachment-1",
        name: "diagram.png",
        previewUrl: "blob:diagram",
        base64Data: "aW1hZ2U=",
      }],
    });
    const { context, updates } = createContext([local, container]);
    const commands = createCommandRegistry();

    await commands.get("stop_environment")?.({ environmentId: local.id }, context);
    // A stopped environment cannot honour a post-setup agent launch, and the
    // renderer no longer mounts it, so the intent is dropped here.
    const localStopUpdates = updatesWithStatus(updates, "stopped");
    expect(localStopUpdates).toHaveLength(1);
    expectClearsPendingAgentLaunch(localStopUpdates[0]);
    // The update actually lands on the stored environment, so a restart cannot
    // resurrect the previous run's model.
    expect(local.pendingAgentLaunch).toBe(false);
    expect(local.initialAgentModel).toBeUndefined();
    expect(local.initialReasoningEffort).toBeUndefined();
    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
exit 0
`, async (logs) => {
      await commands.get("stop_environment")?.({ environmentId: container.id }, context);
      expect(await fs.readFile(logs.all, "utf8")).toContain("stop container-1");
    });
    // Both lanes clear it, containerized as well as local.
    const allStopUpdates = updatesWithStatus(updates, "stopped");
    expect(allStopUpdates).toHaveLength(2);
    expectClearsPendingAgentLaunch(allStopUpdates[1]);
    expect(container.pendingAgentLaunch).toBe(false);
    expect(container.initialAgentModel).toBeUndefined();
    expect(container.initialReasoningEffort).toBeUndefined();
    await expect(commands.get("recreate_environment")?.({ environmentId: local.id }, context)).resolves.toBeUndefined();
  });

  test("stopping a local environment also stops its bridge processes", async () => {
    const worktreePath = await createTempDir("ork-electron-stop-local-");
    const environment = createEnvironment({
      id: "env-stop-local",
      environmentType: "local",
      containerId: null,
      worktreePath,
      localCodexPort: 40201,
      codexBridgePid: 95001,
    });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();
    const child = createFakeChild(95001);
    commandTesting.setLocalServerProcess(`codex:${environment.id}`, child);
    commandTesting.setTerminateProcessTree(async () => true);

    await commands.get("stop_environment")?.({ environmentId: environment.id }, context);

    // The bridge is gone and its ownership entry released, so a later start
    // does not think a server is already running.
    expect(commandTesting.getLocalServerProcess(`codex:${environment.id}`)).toBeUndefined();
    expect(updates).toContainEqual({ codexBridgePid: null, localCodexPort: null });
    expect(updates).toContainEqual({
      status: "stopped",
      lifecycleError: null,
      pendingAgentLaunch: false,
    });
  });

  test("a local environment is still marked stopped when a bridge refuses to die", async () => {
    const worktreePath = await createTempDir("ork-electron-stop-local-failure-");
    const environment = createEnvironment({
      id: "env-stop-local-failure",
      environmentType: "local",
      containerId: null,
      worktreePath,
    });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();
    commandTesting.setLocalServerProcess(`codex:${environment.id}`, createFakeChild(95002));
    commandTesting.setTerminateProcessTree(async () => false);

    // The failure is surfaced...
    await expect(commands.get("stop_environment")?.(
      { environmentId: environment.id },
      context,
    )).rejects.toThrow("Failed to stop all local servers");

    // ...but not at the cost of stranding the environment as running, with no
    // way for the user to stop it from the UI.
    expect(updates).toContainEqual({ status: "stopped", pendingAgentLaunch: false });

    commandTesting.setTerminateProcessTree(async () => true);
  });

  test("stores PR metadata, normalized settings, and deduplicated domain changes", async () => {
    const environment = createEnvironment({
      allowedDomains: ["api.example.com", "shared.example.com"],
      initialPromptAttachments: [{
        id: "attachment-1",
        name: "diagram.png",
        previewUrl: "blob:diagram",
        base64Data: "aW1hZ2U=",
      }],
    });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();

    await commands.get("set_environment_pr")?.({
      environmentId: environment.id,
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "open",
      hasMergeConflicts: false,
    }, context);
    expect(updates).toContainEqual({
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "open",
      hasMergeConflicts: false,
    });
    await expect(commands.get("get_environment_pr_url")?.({ environmentId: environment.id }, context))
      .resolves.toBe("https://github.com/acme/repo/pull/42");
    await commands.get("clear_environment_pr")?.({ environmentId: environment.id }, context);
    expect(updates).toContainEqual({ prUrl: null, prState: null, hasMergeConflicts: null });
    await expect(commands.get("get_environment_pr_url")?.({ environmentId: "missing" }, context)).resolves.toBeNull();

    await commands.get("update_port_mappings")?.({
      environmentId: environment.id,
      portMappings: [{ hostPort: 3000, containerPort: 3001, protocol: "tcp" }],
    }, context);
    expect(updates).toContainEqual({
      portMappings: [{ hostPort: 3000, containerPort: 3001, protocol: "tcp" }],
    });
    await commands.get("update_port_mappings")?.({ environmentId: environment.id, portMappings: null }, context);
    expect(updates).toContainEqual({ portMappings: [] });
    await commands.get("update_environment_agent_settings")?.({
      environmentId: environment.id,
      defaultAgent: "codex",
      claudeMode: "native",
      claudeNativeBackend: "bridge",
      opencodeMode: "native",
      codexMode: "native",
      pendingAgentLaunch: true,
      initialAgentModel: "gpt-5.6-sol",
      initialReasoningEffort: "high",
    }, context);
    expect(updates).toContainEqual({
      defaultAgent: "codex",
      claudeMode: "native",
      claudeNativeBackend: "bridge",
      opencodeMode: "native",
      codexMode: "native",
      pendingAgentLaunch: true,
      initialAgentModel: "gpt-5.6-sol",
      initialReasoningEffort: "high",
    });
    await commands.get("update_environment_agent_settings")?.({
      environmentId: environment.id,
      defaultAgent: "codex",
      claudeMode: null,
      claudeNativeBackend: null,
      opencodeMode: null,
      codexMode: "native",
      pendingAgentLaunch: false,
      initialAgentModel: "must-not-survive",
      initialReasoningEffort: "ultra",
    }, context);
    // Clearing the flag must emit both option keys explicitly: `updateEnvironment`
    // only clears a stored field when the key is present, so dropping the keys
    // here would leave the previous run's model on the environment.
    expect(updates.at(-1)).toEqual({
      defaultAgent: "codex",
      claudeMode: null,
      claudeNativeBackend: null,
      opencodeMode: null,
      codexMode: "native",
      pendingAgentLaunch: false,
      initialAgentModel: undefined,
      initialReasoningEffort: undefined,
      initialPromptAttachments: undefined,
    });
    expectClearsPendingAgentLaunch(updates.at(-1));
    // ...and the stored environment really loses the model it had from the first
    // call in this test, rather than silently keeping "gpt-5.6-sol".
    expect(environment.initialAgentModel).toBeUndefined();
    expect(environment.initialReasoningEffort).toBeUndefined();
    expect(environment.initialPromptAttachments).toBeUndefined();
    await commands.get("update_environment_agent_settings")?.({
      environmentId: environment.id,
      defaultAgent: "codex",
      claudeMode: null,
      claudeNativeBackend: null,
      opencodeMode: null,
      codexMode: "native",
      initialAgentModel: "gpt-5.4-mini",
      initialReasoningEffort: "medium",
    }, context);
    expect(updates.at(-1)).toEqual({
      defaultAgent: "codex",
      claudeMode: null,
      claudeNativeBackend: null,
      opencodeMode: null,
      codexMode: "native",
      initialAgentModel: "gpt-5.4-mini",
      initialReasoningEffort: "medium",
    });
    expect(updates.at(-1)).not.toHaveProperty("pendingAgentLaunch");
    await commands.get("update_environment_agent_settings")?.({
      environmentId: environment.id,
      defaultAgent: "codex",
      claudeMode: null,
      claudeNativeBackend: null,
      opencodeMode: null,
      codexMode: "native",
      initialAgentModel: 42,
      initialReasoningEffort: {},
    }, context);
    expect(updates.at(-1)).toEqual({
      defaultAgent: "codex",
      claudeMode: null,
      claudeNativeBackend: null,
      opencodeMode: null,
      codexMode: "native",
    });
    // Omitting the flag must leave an in-flight launch intent alone: the settings
    // dialog, FeaturesView and the non-Claude pipeline lanes all call this
    // command without it while an environment may still be awaiting its launch.
    await commands.get("update_environment_agent_settings")?.({
      environmentId: environment.id,
      defaultAgent: "claude",
      claudeMode: "terminal",
      claudeNativeBackend: null,
      opencodeMode: null,
      codexMode: null,
    }, context);
    expect(updates).toContainEqual({
      defaultAgent: "claude",
      claudeMode: "terminal",
      claudeNativeBackend: null,
      opencodeMode: null,
      codexMode: null,
    });
    expect(updates.at(-1)).not.toHaveProperty("pendingAgentLaunch");
    // A non-boolean must not be coerced either.
    await commands.get("update_environment_agent_settings")?.({
      environmentId: environment.id,
      defaultAgent: "claude",
      claudeMode: "terminal",
      claudeNativeBackend: null,
      opencodeMode: null,
      codexMode: null,
      pendingAgentLaunch: "true",
    }, context);
    expect(updates.at(-1)).not.toHaveProperty("pendingAgentLaunch");

    // Re-arm a launch with options so the clear below has something to destroy.
    await commands.get("update_environment_agent_settings")?.({
      environmentId: environment.id,
      defaultAgent: "codex",
      claudeMode: null,
      claudeNativeBackend: null,
      opencodeMode: null,
      codexMode: "native",
      pendingAgentLaunch: true,
      initialAgentModel: "gpt-5.6-sol",
      initialReasoningEffort: "high",
    }, context);
    expect(environment.initialAgentModel).toBe("gpt-5.6-sol");

    await commands.get("set_environment_pending_agent_launch")?.({
      environmentId: environment.id,
      pending: false,
    }, context);
    expectClearsPendingAgentLaunch(updates.at(-1));
    expect(environment.initialAgentModel).toBeUndefined();
    expect(environment.initialReasoningEffort).toBeUndefined();
    await commands.get("set_environment_pending_agent_launch")?.({
      environmentId: environment.id,
      pending: true,
    }, context);
    // Arming must not touch the options: the renderer sets the model through
    // `update_environment_agent_settings`, and clobbering it here would drop a
    // choice that had already been recorded.
    expect(updates.at(-1)).toEqual({ pendingAgentLaunch: true });
    expect(updates.at(-1)).not.toHaveProperty("initialAgentModel");
    expect(updates.at(-1)).not.toHaveProperty("initialReasoningEffort");
    // A malformed call must fail rather than silently destroying the intent by
    // reading a missing/garbage value as `false`.
    expect(() => commands.get("set_environment_pending_agent_launch")?.({
      environmentId: environment.id,
    }, context)).toThrow("Expected pending to be a boolean");
    expect(() => commands.get("set_environment_pending_agent_launch")?.({
      environmentId: environment.id,
      pending: "false",
    }, context)).toThrow("Expected pending to be a boolean");

    await commands.get("set_environment_initial_prompt")?.({
      environmentId: environment.id,
      initialPrompt: "Fix the bug [image](/work/attachment-1.png)",
    }, context);
    expect(updates).toContainEqual({
      initialPrompt: "Fix the bug [image](/work/attachment-1.png)",
    });
    expect(() => commands.get("set_environment_initial_prompt")?.({
      environmentId: environment.id,
      initialPrompt: 42,
    }, context)).toThrow("Expected initialPrompt to be a string");
    await commands.get("update_environment_allowed_domains")?.({
      environmentId: environment.id,
      domains: ["one.example.com", "two.example.com"],
    }, context);
    expect(updates).toContainEqual({ allowedDomains: ["one.example.com", "two.example.com"] });

    environment.allowedDomains = ["api.example.com", "shared.example.com"];
    await expect(commands.get("add_environment_domains")?.({
      environmentId: environment.id,
      domains: ["shared.example.com", "new.example.com"],
    }, context)).resolves.toBe("api.example.com,shared.example.com,new.example.com");
    expect(updates).toContainEqual({
      allowedDomains: ["api.example.com", "shared.example.com", "new.example.com"],
    });
    await expect(commands.get("remove_environment_domains")?.({
      environmentId: environment.id,
      domains: ["shared.example.com"],
    }, context)).resolves.toBe("api.example.com,new.example.com");
    await expect(commands.get("add_environment_domains")?.({
      environmentId: "missing",
      domains: [],
    }, context)).rejects.toThrow("Environment not found: missing");
    await expect(commands.get("remove_environment_domains")?.({
      environmentId: "missing",
      domains: [],
    }, context)).rejects.toThrow("Environment not found: missing");
  });
});

test("build pipeline point reads omit unchanged transcripts and return tail patches", async () => {
  const environment = createEnvironment();
  const { context } = createContext(environment);
  const record = {
    version: 2,
    id: "pipeline-1",
    projectId: environment.projectId,
    environmentId: environment.id,
    revision: 8,
    updatedAt: new Date().toISOString(),
    snapshot: {
      id: "pipeline-1",
      sessions: [{
        sessionKey: "session-1",
        messageRevision: 3,
        messages: [{ id: "m1" }, { id: "m2-old" }, { id: "m3" }],
      }],
    },
  };
  context.storage.getBuildPipeline = mock(async () => record);
  const commands = createCommandRegistry();

  expect(await commands.get("get_build_pipeline")?.({
    pipelineId: record.id,
    knownRevision: 8,
  }, context)).toEqual({ unchanged: true, revision: 8 });

  expect(await commands.get("get_build_pipeline")?.({
    pipelineId: record.id,
    knownRevision: 7,
    knownSessions: {
      "session-1": { revision: 2, count: 2 },
    },
  }, context)).toMatchObject({
    unchanged: false,
    record: {
      revision: 8,
      snapshot: {
        sessions: [{ sessionKey: "session-1", messageRevision: 3 }],
      },
    },
    messagePatches: [{
      sessionKey: "session-1",
      baseRevision: 2,
      baseCount: 2,
      startIndex: 1,
      revision: 3,
      messages: [{ id: "m2-old" }, { id: "m3" }],
    }],
  });

  expect(await commands.get("get_build_pipeline")?.({
    pipelineId: record.id,
    knownRevision: 7,
    knownSessions: {
      "session-1": { revision: 3, count: 3 },
    },
  }, context)).toMatchObject({
    unchanged: false,
    record: {
      revision: 8,
      snapshot: {
        sessions: [{ sessionKey: "session-1", messageRevision: 3 }],
      },
    },
    messagePatches: [],
  });

  expect(await commands.get("get_build_pipeline")?.({
    pipelineId: record.id,
    knownRevision: 7,
    knownSessions: {
      "session-1": { revision: 2, count: 99 },
    },
  }, context)).toMatchObject({
    unchanged: false,
    messagePatches: [{
      sessionKey: "session-1",
      startIndex: 0,
      revision: 3,
      messages: [{ id: "m1" }, { id: "m2-old" }, { id: "m3" }],
    }],
  });

  expect(await commands.get("get_build_pipeline")?.({
    pipelineId: record.id,
    knownRevision: "8",
  }, context)).toBe(record);

  context.storage.getBuildPipeline = mock(async () => null);
  expect(await commands.get("get_build_pipeline")?.({
    pipelineId: "missing",
    knownRevision: 1,
    knownSessions: {},
  }, context)).toBeNull();
});

test("build pipeline list reads return only changed records and retain deletion ids", async () => {
  const environment = createEnvironment();
  const { context } = createContext(environment);
  const records = [
    {
      version: 2,
      id: "pipeline-1",
      projectId: environment.projectId,
      environmentId: environment.id,
      revision: 2,
      updatedAt: new Date().toISOString(),
      snapshot: { id: "pipeline-1" },
    },
    {
      version: 2,
      id: "pipeline-2",
      projectId: environment.projectId,
      environmentId: environment.id,
      revision: 4,
      updatedAt: new Date().toISOString(),
      snapshot: { id: "pipeline-2" },
    },
  ];
  context.storage.listBuildPipelines = mock(async () => records);
  const commands = createCommandRegistry();

  expect(await commands.get("list_build_pipelines")?.({
    projectId: environment.projectId,
  }, context)).toBe(records);
  expect(await commands.get("list_build_pipelines")?.({
    projectId: environment.projectId,
    knownRevisions: [],
  }, context)).toBe(records);
  expect(await commands.get("list_build_pipelines")?.({
    projectId: environment.projectId,
    knownRevisions: {
      "pipeline-1": 2,
      "pipeline-2": 3,
      "pipeline-deleted": 7,
    },
  }, context)).toEqual({
    ids: ["pipeline-1", "pipeline-2"],
    records: [records[1]],
  });

  context.storage.listBuildPipelines = mock(async () => []);
  expect(await commands.get("list_build_pipelines")?.({
    projectId: environment.projectId,
    knownRevisions: { "pipeline-deleted": 7 },
  }, context)).toEqual({
    ids: [],
    records: [],
  });
});

describe("storage-backed command delegation", () => {
  test("validates and delegates project and configuration commands", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    const project = { id: "project-1", name: "repo" };
    let config = {
      version: "1.0.0",
      global: { allowedDomains: [] as string[], githubToken: "github_secret_token" },
      repositories: {} as Record<string, RepositoryConfig>,
    };
    const repositoryConfig = { defaultBranch: "develop", prBaseBranch: "develop" };
    const storage = {
      loadProjects: mock(async () => [project]),
      addProject: mock(async (value: Record<string, unknown>) => value),
      removeProject: mock(async (id: string) => id),
      getProject: mock(async () => project),
      updateProject: mock(async (_id: string, updates: Record<string, unknown>) => updates),
      reorderProjects: mock(async (ids: string[]) => ids),
      loadConfig: mock(async () => config),
      saveConfig: mock(async (value: typeof config) => {
        config = value;
      }),
      updateGlobalConfig: mock(async (value: typeof config.global) => {
        config = { ...config, global: value };
        return config;
      }),
      updateAgentModelDefault: mock(async (
        key: "claudeModel" | "codexModel" | "opencodeModel",
        modelId: string,
      ) => {
        config = { ...config, global: { ...config.global, [key]: modelId } };
        return config;
      }),
      setGitHubToken: mock(async (token: string | null) => {
        const { githubToken: _removed, ...global } = config.global;
        config = {
          ...config,
          global: token === null ? global : { ...global, githubToken: token },
        };
        return config;
      }),
      getRepositoryConfig: mock(async () => repositoryConfig),
      updateRepositoryConfig: mock(async (id: string, value: RepositoryConfig) => {
        config = { ...config, repositories: { ...config.repositories, [id]: value } };
        return config;
      }),
    };
    const context = { storage } as unknown as CommandContext;
    const commands = createCommandRegistry();

    await expect(commands.get("get_projects")?.({}, context)).resolves.toEqual([project]);
    const added = await commands.get("add_project")?.(
      { gitUrl: "https://github.com/acme/repo.git", localPath: "/tmp/repo" },
      context,
    ) as Record<string, unknown>;
    expect(added).toMatchObject({
      gitUrl: "https://github.com/acme/repo.git",
      localPath: "/tmp/repo",
    });
    expect(typeof added.id).toBe("string");
    await expect(commands.get("remove_project")?.({ projectId: "project-1" }, context)).resolves.toBe("project-1");
    await expect(commands.get("get_project")?.({ projectId: "project-1" }, context)).resolves.toEqual(project);
    await expect(commands.get("update_project")?.(
      { projectId: "project-1", updates: { name: "renamed" } },
      context,
    )).resolves.toEqual({ name: "renamed" });
    await expect(commands.get("reorder_projects")?.(
      { projectIds: ["project-2", "project-1"] },
      context,
    )).resolves.toEqual(["project-2", "project-1"]);
    expect(commands.get("validate_git_url")?.({ url: " https://github.com/acme/repo.git " }, context)).toBe(true);
    expect(commands.get("validate_git_url")?.({ url: "git@github.com:acme/repo.git" }, context)).toBe(true);
    expect(commands.get("validate_git_url")?.({ url: "ssh://git@example.com/repo" }, context)).toBe(true);
    expect(commands.get("validate_git_url")?.({ url: "file:///tmp/repo" }, context)).toBe(false);
    await expect(commands.get("get_git_remote_url")?.({ path: worktree }, context)).resolves.toBe(remote);

    await expect(commands.get("get_config")?.({}, context)).resolves.toEqual({
      version: "1.0.0",
      global: { allowedDomains: [], githubTokenConfigured: true },
      repositories: {},
    });
    await expect(commands.get("get_global_config")?.({}, context)).resolves.toEqual({
      allowedDomains: [],
      githubTokenConfigured: true,
    });

    await expect(commands.get("save_config")?.({
      config: {
        version: "1.0.0",
        global: {
          allowedDomains: ["api.example.com"],
          githubToken: "renderer_attempted_secret",
          githubTokenConfigured: false,
        },
        repositories: {},
      },
    }, context)).resolves.toBeUndefined();
    expect(storage.saveConfig).toHaveBeenLastCalledWith({
      version: "1.0.0",
      global: {
        allowedDomains: ["api.example.com"],
        githubToken: "github_secret_token",
      },
      repositories: {},
    });

    await expect(commands.get("update_global_config")?.({
      global: {
        allowedDomains: ["github.com"],
        githubToken: "renderer_attempted_secret",
        githubTokenConfigured: false,
      },
    }, context)).resolves.toEqual({
      version: "1.0.0",
      global: { allowedDomains: ["github.com"], githubTokenConfigured: true },
      repositories: {},
    });
    expect(storage.updateGlobalConfig).toHaveBeenLastCalledWith({
      allowedDomains: ["github.com"],
      githubToken: "github_secret_token",
    });

    await expect(commands.get("update_agent_model_default")?.({
      key: "codexModel",
      modelId: "gpt-5.4",
    }, context)).resolves.toMatchObject({
      global: {
        allowedDomains: ["github.com"],
        codexModel: "gpt-5.4",
        githubTokenConfigured: true,
      },
    });
    expect(storage.updateAgentModelDefault).toHaveBeenLastCalledWith(
      "codexModel",
      "gpt-5.4",
    );
    await expect(commands.get("update_agent_model_default")?.({
      key: "reviewInstruction",
      modelId: "unsafe",
    }, context)).rejects.toThrow("Expected key to identify an agent model default");
    // A blank model id would be written verbatim into a required config field.
    storage.updateAgentModelDefault.mockClear();
    await expect(commands.get("update_agent_model_default")?.({
      key: "codexModel",
      modelId: "   ",
    }, context)).rejects.toThrow("Expected modelId to be non-empty");
    await expect(commands.get("update_agent_model_default")?.({
      key: "codexModel",
      modelId: "",
    }, context)).rejects.toThrow("Expected modelId to be non-empty");
    expect(storage.updateAgentModelDefault).not.toHaveBeenCalled();
    // Surrounding whitespace is trimmed rather than persisted.
    await expect(commands.get("update_agent_model_default")?.({
      key: "claudeModel",
      modelId: "  claude-opus-4  ",
    }, context)).resolves.toMatchObject({
      global: { claudeModel: "claude-opus-4" },
    });
    expect(storage.updateAgentModelDefault).toHaveBeenLastCalledWith(
      "claudeModel",
      "claude-opus-4",
    );

    await expect(commands.get("set_github_token")?.({ token: " replacement_token " }, context))
      .resolves.toMatchObject({
        global: { allowedDomains: ["github.com"], githubTokenConfigured: true },
      });
    expect(storage.setGitHubToken).toHaveBeenLastCalledWith("replacement_token");
    expect(JSON.stringify(await commands.get("get_config")?.({}, context))).not.toContain("replacement_token");
    await expect(commands.get("set_github_token")?.({ token: null }, context)).resolves.toMatchObject({
      global: { githubTokenConfigured: false },
    });
    await expect(commands.get("set_github_token")?.({ token: "   " }, context))
      .rejects.toThrow("GitHub token cannot be empty");

    await expect(commands.get("get_repository_config")?.({ projectId: "project-1" }, context))
      .resolves.toEqual(repositoryConfig);
    await expect(commands.get("update_repository_config")?.(
      { projectId: "project-1", repoConfig: repositoryConfig },
      context,
    )).resolves.toMatchObject({
      global: { githubTokenConfigured: false },
      repositories: { "project-1": repositoryConfig },
    });

    expect(storage.removeProject).toHaveBeenCalledWith("project-1");
    expect(storage.updateProject).toHaveBeenCalledWith("project-1", { name: "renamed" });
    expect(storage.updateRepositoryConfig).toHaveBeenCalledWith("project-1", repositoryConfig);
  });

  test("delegates session lifecycle, synchronization, and buffer commands", async () => {
    const session = { id: "session-1", environmentId: "env-1" };
    const sessions = [session];
    const disconnected = [{ ...session, status: "disconnected" }];
    const storage = {
      createSession: mock(async () => session),
      getSession: mock(async () => session),
      getSessionsByEnvironment: mock(async () => sessions),
      updateSession: mock(async (_id: string, update: Record<string, unknown>) => ({ ...session, ...update })),
      removeSession: mock(async () => undefined),
      removeSessionsByEnvironment: mock(async () => undefined),
      disconnectEnvironmentSessions: mock(async () => disconnected),
      saveSessionBuffer: mock(async () => undefined),
      loadSessionBuffer: mock(async () => "saved output"),
      reorderSessions: mock(async () => sessions),
      cleanupOrphanedBuffers: mock(async () => 3),
    };
    const context = { storage } as unknown as CommandContext;
    const commands = createCommandRegistry();

    await expect(commands.get("create_session")?.({
      environmentId: "env-1",
      containerId: "container-1",
      tabId: "tab-1",
      sessionType: "terminal",
    }, context)).resolves.toEqual(session);
    expect(storage.createSession).toHaveBeenCalledWith("env-1", "container-1", "tab-1", "terminal");
    await expect(commands.get("get_session")?.({ sessionId: "session-1" }, context)).resolves.toEqual(session);
    await expect(commands.get("get_sessions_by_environment")?.({ environmentId: "env-1" }, context))
      .resolves.toEqual(sessions);
    await commands.get("update_session_status")?.({ sessionId: "session-1", status: "running" }, context);
    expect(storage.updateSession).toHaveBeenLastCalledWith("session-1", { status: "running" });
    await withFixedDate("2026-07-23T12:00:00.000Z", async () => {
      await commands.get("update_session_activity")?.({ sessionId: "session-1" }, context);
    });
    expect(storage.updateSession).toHaveBeenLastCalledWith("session-1", {
      lastActivityAt: "2026-07-23T12:00:00.000Z",
    });
    await commands.get("rename_session")?.({ sessionId: "session-1", name: "Shell" }, context);
    expect(storage.updateSession).toHaveBeenLastCalledWith("session-1", { name: "Shell" });
    await commands.get("rename_session")?.({ sessionId: "session-1", name: null }, context);
    expect(storage.updateSession).toHaveBeenLastCalledWith("session-1", { name: undefined });
    await commands.get("set_session_has_launched_command")?.(
      { sessionId: "session-1", hasLaunched: true },
      context,
    );
    expect(storage.updateSession).toHaveBeenLastCalledWith("session-1", { hasLaunchedCommand: true });
    await commands.get("save_session_buffer")?.({ sessionId: "session-1", buffer: "saved output" }, context);
    expect(storage.saveSessionBuffer).toHaveBeenCalledWith("session-1", "saved output");
    await expect(commands.get("load_session_buffer")?.({ sessionId: "session-1" }, context))
      .resolves.toBe("saved output");
    await expect(commands.get("sync_sessions_with_container")?.(
      { environmentId: "env-1", containerRunning: true },
      context,
    )).resolves.toEqual(sessions);
    expect(storage.disconnectEnvironmentSessions).not.toHaveBeenCalled();
    await expect(commands.get("sync_sessions_with_container")?.(
      { environmentId: "env-1", containerRunning: false },
      context,
    )).resolves.toEqual(disconnected);
    await expect(commands.get("disconnect_environment_sessions")?.({ environmentId: "env-1" }, context))
      .resolves.toEqual(disconnected);
    await commands.get("reorder_sessions")?.(
      { environmentId: "env-1", sessionIds: ["session-2", "session-1"] },
      context,
    );
    expect(storage.reorderSessions).toHaveBeenCalledWith("env-1", ["session-2", "session-1"]);
    await expect(commands.get("cleanup_orphaned_buffers")?.({}, context)).resolves.toBe(3);
    await commands.get("delete_session")?.({ sessionId: "session-1" }, context);
    expect(storage.removeSession).toHaveBeenCalledWith("session-1");
    await commands.get("delete_sessions_by_environment")?.({ environmentId: "env-1" }, context);
    expect(storage.removeSessionsByEnvironment).toHaveBeenCalledWith("env-1");
  });

  test("delegates Kanban reads and typed updates", async () => {
    const task = { id: "task-1", title: "Investigate" };
    const storage = {
      getKanbanTasks: mock(async () => [task]),
      addKanbanTask: mock(async () => task),
      updateKanbanTask: mock(async (_id: string, update: Record<string, unknown>) => ({ ...task, ...update })),
    };
    const context = { storage } as unknown as CommandContext;
    const commands = createCommandRegistry();

    await expect(commands.get("get_kanban_tasks")?.({ projectId: "project-1" }, context)).resolves.toEqual([task]);
    await expect(commands.get("add_kanban_task")?.(
      { projectId: "project-1", title: "Investigate", description: "Details" },
      context,
    )).resolves.toEqual(task);
    expect(storage.addKanbanTask).toHaveBeenCalledWith("project-1", "Investigate", "Details");
    await commands.get("update_kanban_task")?.({
      taskId: "task-1",
      title: "Fixed",
      description: 123,
      acceptanceCriteria: "Tests pass",
      status: "done",
      environmentId: "",
      buildPipelineId: "",
      prUrl: "",
      prState: "merged",
      prMergeCommented: false,
    }, context);
    expect(storage.updateKanbanTask).toHaveBeenCalledWith("task-1", {
      title: "Fixed",
      acceptanceCriteria: "Tests pass",
      status: "done",
      environmentId: undefined,
      buildPipelineId: undefined,
      prUrl: undefined,
      prState: "merged",
      prMergeCommented: false,
    });
  });

  test("unlinks a task even when one build-pipeline cleanup fails", async () => {
    const task = {
      id: "task-1",
      projectId: "project-1",
      buildPipelineId: "pipeline-linked",
    };
    const updated = { ...task, environmentId: undefined, buildPipelineId: undefined };
    const storage = {
      getKanbanTask: mock(async () => task),
      listBuildPipelines: mock(async () => [
        { id: "pipeline-linked", snapshot: { taskId: "task-1" } },
        { id: "pipeline-stale", snapshot: { taskId: "task-1" } },
      ]),
      updateKanbanTask: mock(async () => updated),
    };
    const remove = mock(async (pipelineId: string) => {
      if (pipelineId === "pipeline-stale") throw new Error("cleanup failed");
    });
    const context = {
      storage,
      buildPipelines: { remove },
    } as unknown as CommandContext;

    await expect(createCommandRegistry().get("clear_task_build_status")?.(
      { taskId: "task-1" },
      context,
    )).resolves.toEqual({
      task: updated,
      removedPipelineIds: ["pipeline-linked"],
      failedPipelineIds: ["pipeline-stale"],
    });
    expect(storage.updateKanbanTask).toHaveBeenCalledWith("task-1", {
      environmentId: undefined,
      buildPipelineId: undefined,
      prUrl: "",
      prState: undefined,
    });
  });

  test("delegates remaining environment, Kanban, notes, and feature-plan handlers", async () => {
    const task = { id: "task-1" };
    const feature = { id: "feature-1", projectId: "project-1" };
    const storage = {
      getLogDirectory: mock(() => "/data/logs"),
      reorderEnvironments: mock(async () => [{ id: "env-2" }, { id: "env-1" }]),
      deleteKanbanTask: mock(async () => undefined),
      addKanbanComment: mock(async () => ({ ...task, comments: [{ id: "comment-1" }] })),
      deleteKanbanComment: mock(async () => ({ ...task, comments: [] })),
      addKanbanImage: mock(async () => ({ ...task, images: [{ id: "image-1" }] })),
      deleteKanbanImage: mock(async () => ({ ...task, images: [] })),
      getKanbanImageData: mock(async () => "encoded-image"),
      getProjectNotes: mock(async () => ({ projectId: "project-1", content: "notes" })),
      saveProjectNotes: mock(async () => ({ projectId: "project-1", content: "updated" })),
      getFeaturePlans: mock(async () => [feature]),
      createFeaturePlan: mock(async () => feature),
      updateFeaturePlan: mock(async () => ({ ...feature, title: "Updated" })),
    };
    const context = { storage } as unknown as CommandContext;
    const commands = createCommandRegistry();

    expect(commands.get("get_log_directory")?.({}, context)).toBe("/data/logs");
    await expect(commands.get("reorder_environments")?.({
      projectId: "project-1",
      environmentIds: ["env-2", "env-1"],
    }, context)).resolves.toEqual([
      { id: "env-2", hasInitialPromptAttachments: false },
      { id: "env-1", hasInitialPromptAttachments: false },
    ]);
    expect(storage.reorderEnvironments).toHaveBeenCalledWith(
      "project-1",
      ["env-2", "env-1"],
    );

    await commands.get("delete_kanban_task")?.({ taskId: "task-1" }, context);
    await commands.get("add_kanban_comment")?.(
      { taskId: "task-1", text: "Looks good" },
      context,
    );
    await commands.get("delete_kanban_comment")?.(
      { taskId: "task-1", commentId: "comment-1" },
      context,
    );
    await commands.get("add_kanban_image")?.(
      { taskId: "task-1", filename: "image.png", data: "encoded" },
      context,
    );
    await commands.get("delete_kanban_image")?.(
      { taskId: "task-1", imageId: "image-1" },
      context,
    );
    await expect(commands.get("get_kanban_image_data")?.(
      { imageId: "image-1" },
      context,
    )).resolves.toBe("encoded-image");
    expect(storage.deleteKanbanTask).toHaveBeenCalledWith("task-1");
    expect(storage.addKanbanComment).toHaveBeenCalledWith("task-1", "Looks good");
    expect(storage.deleteKanbanComment).toHaveBeenCalledWith("task-1", "comment-1");
    expect(storage.addKanbanImage).toHaveBeenCalledWith("task-1", "image.png", "encoded");
    expect(storage.deleteKanbanImage).toHaveBeenCalledWith("task-1", "image-1");

    await expect(commands.get("get_project_notes")?.(
      { projectId: "project-1" },
      context,
    )).resolves.toEqual({ projectId: "project-1", content: "notes" });
    await expect(commands.get("save_project_notes")?.(
      { projectId: "project-1", content: "updated" },
      context,
    )).resolves.toEqual({ projectId: "project-1", content: "updated" });
    expect(storage.saveProjectNotes).toHaveBeenCalledWith("project-1", "updated");

    await expect(commands.get("get_feature_plans")?.(
      { projectId: "project-1" },
      context,
    )).resolves.toEqual([feature]);
    await expect(commands.get("create_feature_plan")?.(
      { projectId: "project-1" },
      context,
    )).resolves.toEqual(feature);
    await expect(commands.get("update_feature_plan")?.(
      { featureId: "feature-1", updates: { title: "Updated" } },
      context,
    )).resolves.toEqual({ ...feature, title: "Updated" });
    expect(storage.updateFeaturePlan).toHaveBeenCalledWith(
      "feature-1",
      { title: "Updated" },
    );
    expect(() => commands.get("update_feature_plan")?.(
      { featureId: 1, updates: {} },
      context,
    )).toThrow("Expected featureId to be a string");
  });
});

describe("pane layout commands", () => {
  test("validates and forwards pane layout envelopes", async () => {
    const persisted = {
      // Reads stay version-agnostic so the renderer can migrate legacy data.
      version: 1,
      environmentId: "env-1",
      containerId: null,
      activePaneId: "default",
      root: { kind: "leaf", id: "default", tabs: [], activeTabId: null },
      updatedAt: new Date(0).toISOString(),
      revision: 1,
    };
    const getPaneLayout = mock(async () => persisted);
    const savePaneLayout = mock(async (
      environmentId: string,
      layout: Record<string, unknown>,
      _expectedRevision: number,
    ) => ({
      ...layout,
      environmentId,
      updatedAt: new Date(0).toISOString(),
      revision: 1,
    }));
    const deletePaneLayout = mock(async () => undefined);
    const context = {
      storage: {
        getPaneLayout,
        savePaneLayout,
        deletePaneLayout,
      },
    } as unknown as CommandContext;
    const commands = createCommandRegistry();
    const root = { kind: "leaf", id: "default", tabs: [], activeTabId: null };

    await commands.get("save_pane_layout")?.({
      environmentId: "env-1",
      layout: {
        version: 2,
        containerId: null,
        activePaneId: "default",
        root,
      },
      expectedRevision: 0,
    }, context);

    expect(savePaneLayout).toHaveBeenCalledWith("env-1", {
      version: 2,
      containerId: null,
      activePaneId: "default",
      root,
    }, 0);
    await expect(commands.get("get_pane_layout")?.({ environmentId: "env-1" }, context))
      .resolves.toEqual(persisted);
    expect(getPaneLayout).toHaveBeenCalledWith("env-1");
    await expect(commands.get("delete_pane_layout")?.({ environmentId: "env-1" }, context))
      .resolves.toBeUndefined();
    expect(deletePaneLayout).toHaveBeenCalledWith("env-1");
    await expect(commands.get("save_pane_layout")?.({
      environmentId: "env-1",
      layout: { version: 2, containerId: null, activePaneId: "", root },
      expectedRevision: 0,
    }, context)).rejects.toThrow("non-empty");
    await expect(commands.get("save_pane_layout")?.({
      environmentId: "env-1",
      layout: { version: 2, containerId: null, activePaneId: "default", root: [] },
      expectedRevision: 0,
    }, context)).rejects.toThrow("layout.root");
    await expect(commands.get("save_pane_layout")?.({
      environmentId: "env-1",
      layout: { version: 2, containerId: null, activePaneId: "default", root },
    }, context)).rejects.toThrow("Expected expectedRevision to be a number");
  });

  test("rejects older and future pane layout writes before reaching storage", async () => {
    const savePaneLayout = mock(async () => ({}));
    const context = { storage: { savePaneLayout } } as unknown as CommandContext;
    const commands = createCommandRegistry();
    const root = { kind: "leaf", id: "default", tabs: [], activeTabId: null };

    for (const version of [1, 3]) {
      await expect(commands.get("save_pane_layout")?.({
        environmentId: "env-1",
        layout: { version, containerId: null, activePaneId: "default", root },
        expectedRevision: 0,
      }, context)).rejects.toThrow(`Unsupported pane layout version: ${version}`);
    }

    expect(savePaneLayout).not.toHaveBeenCalled();
  });

  test("rejects a non-numeric expectedRevision before reaching storage", async () => {
    const savePaneLayout = mock(async () => ({}));
    const context = { storage: { savePaneLayout } } as unknown as CommandContext;
    const commands = createCommandRegistry();
    const root = { kind: "leaf", id: "default", tabs: [], activeTabId: null };
    const layout = { version: 2, containerId: null, activePaneId: "default", root };

    for (const expectedRevision of ["0", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(commands.get("save_pane_layout")?.({
        environmentId: "env-1",
        layout,
        expectedRevision,
      }, context)).rejects.toThrow("Expected expectedRevision to be a number");
    }
    expect(savePaneLayout).not.toHaveBeenCalled();
  });

  test("propagates a storage revision conflict with the marker intact", async () => {
    const conflict = new Error(paneLayoutRevisionConflictMessage(3, 5));
    const savePaneLayout = mock(async () => {
      throw conflict;
    });
    const context = { storage: { savePaneLayout } } as unknown as CommandContext;
    const commands = createCommandRegistry();
    const root = { kind: "leaf", id: "default", tabs: [], activeTabId: null };

    const rejection = await commands.get("save_pane_layout")?.({
      environmentId: "env-1",
      layout: { version: 2, containerId: null, activePaneId: "default", root },
      expectedRevision: 3,
    }, context).then(() => null, (error: unknown) => error);

    expect(rejection).toBe(conflict);
    // The renderer's rebase-and-retry path keys off this predicate alone.
    expect(isPaneLayoutRevisionConflict(rejection)).toBe(true);
    expect(savePaneLayout).toHaveBeenCalledWith("env-1", {
      version: 2,
      containerId: null,
      activePaneId: "default",
      root,
    }, 3);
  });
});

describe("feature plan commands", () => {
  function featureContext() {
    const storage = {
      createFeaturePlan: mock(async () => ({ id: "feature-1" })),
      updateFeaturePlan: mock(async () => ({ id: "feature-1" })),
      getFeaturePlans: mock(async () => []),
      appendFeaturePlanMessage: mock(async () => ({ id: "feature-1" })),
      appendFeatureStoryMessage: mock(async () => ({ id: "feature-1" })),
    };
    return { context: { storage } as unknown as CommandContext, storage };
  }

  test("forwards a valid feature plan message role to storage", async () => {
    const commands = createCommandRegistry();
    const { context, storage } = featureContext();

    await commands.get("append_feature_plan_message")?.(
      { featureId: "feature-1", role: "assistant", content: "hello" },
      context,
    );

    expect(storage.appendFeaturePlanMessage).toHaveBeenCalledWith(
      "feature-1",
      "assistant",
      "hello",
      undefined,
      undefined,
    );
  });

  test("validates and forwards feature-plan state application metadata", async () => {
    const commands = createCommandRegistry();
    const { context, storage } = featureContext();

    await commands.get("append_feature_plan_message")?.(
      {
        featureId: "feature-1",
        role: "assistant",
        content: "hello",
        stateApplication: "pending",
        modelId: "  gpt-5.3-codex  ",
      },
      context,
    );
    expect(storage.appendFeaturePlanMessage).toHaveBeenCalledWith(
      "feature-1",
      "assistant",
      "hello",
      "pending",
      "gpt-5.3-codex",
    );

    expect(() =>
      commands.get("append_feature_story_message")!(
        {
          featureId: "feature-1",
          storyId: "story-1",
          role: "assistant",
          content: "hello",
          stateApplication: "ignored",
        },
        context,
      ),
    ).toThrow(/stateApplication/i);
    expect(storage.appendFeatureStoryMessage).not.toHaveBeenCalled();
  });

  test("rejects malformed feature-plan model attribution", () => {
    const commands = createCommandRegistry();
    const { context, storage } = featureContext();

    expect(() =>
      commands.get("append_feature_plan_message")!(
        {
          featureId: "feature-1",
          role: "assistant",
          content: "hello",
          modelId: "   ",
        },
        context,
      ),
    ).toThrow(/modelId/i);
    expect(storage.appendFeaturePlanMessage).not.toHaveBeenCalled();
  });

  test("rejects an invalid feature plan message role before touching storage", async () => {
    const commands = createCommandRegistry();
    const { context, storage } = featureContext();

    expect(() =>
      commands.get("append_feature_plan_message")!(
        { featureId: "feature-1", role: "robot", content: "hello" },
        context,
      ),
    ).toThrow(/role/i);
    expect(storage.appendFeaturePlanMessage).not.toHaveBeenCalled();
  });

  test("rejects an invalid story message role before touching storage", async () => {
    const commands = createCommandRegistry();
    const { context, storage } = featureContext();

    expect(() =>
      commands.get("append_feature_story_message")!(
        { featureId: "feature-1", storyId: "story-1", role: "", content: "hello" },
        context,
      ),
    ).toThrow(/role/i);
    expect(storage.appendFeatureStoryMessage).not.toHaveBeenCalled();
  });
});

describe("agent extension discovery commands", () => {
  type RunCall = {
    command: string;
    args: string[];
    options: Record<string, unknown> | undefined;
  };

  function recordingRun(stdout = "") {
    const calls: RunCall[] = [];
    const run = (async (
      command: string,
      args: string[] = [],
      options?: Record<string, unknown>,
    ) => {
      calls.push({ command, args, options });
      return { stdout, stderr: "" };
    }) as unknown as Parameters<typeof commandTesting.createExtensionCommandRunner>[2];
    return { run, calls };
  }

  test("runs the agent CLI inside the worktree for a local environment", async () => {
    const environment = createEnvironment({
      id: "env-local",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      containerId: null,
    });
    const { context } = createContext(environment);
    const { run, calls } = recordingRun("docs: cmd - Connected");

    const runner = commandTesting.createExtensionCommandRunner(environment, context, run);
    await expect(runner("claude", ["mcp", "list"])).resolves.toBe("docs: cmd - Connected");
    await runner("opencode", ["debug", "config"]);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toEqual(["mcp", "list"]);
    expect(calls[0]!.options).toMatchObject({
      cwd: "/tmp/worktree",
      timeoutMs: 20_000,
    });
    // Colour codes would otherwise have to be stripped out of every parser.
    expect((calls[0]!.options as { env: Record<string, string> }).env.NO_COLOR).toBe("1");
    expect(calls[1]!.args).toEqual(["debug", "config"]);
  });

  test("runs the agent CLI in the container for a containerized environment", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      worktreePath: undefined,
    });
    const { context } = createContext(environment);
    const { run, calls } = recordingRun("[]");

    const runner = commandTesting.createExtensionCommandRunner(environment, context, run);
    await expect(runner("codex", ["mcp", "list", "--json"])).resolves.toBe("[]");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("docker");
    expect(calls[0]!.args).toEqual([
      "exec",
      "-e",
      "NO_COLOR=1",
      "-w",
      "/workspace",
      "container-1",
      "codex",
      "mcp",
      "list",
      "--json",
    ]);
    expect(calls[0]!.options).toMatchObject({ timeoutMs: 20_000 });
  });

  test("prefers the container over a stale worktree path when both are set", async () => {
    const environment = createEnvironment({
      id: "env-both",
      environmentType: "containerized",
      containerId: "container-2",
      worktreePath: "/tmp/worktree",
    });
    const { context } = createContext(environment);
    const { run, calls } = recordingRun("[]");

    await commandTesting.createExtensionCommandRunner(environment, context, run)("codex", ["mcp"]);

    expect(calls[0]!.command).toBe("docker");
  });

  test("refuses to run anything when the environment has no worktree and no container", async () => {
    const environment = createEnvironment({
      id: "env-nowhere",
      environmentType: "local",
      worktreePath: undefined,
      containerId: null,
    });
    const { context } = createContext(environment);
    const { run, calls } = recordingRun();

    const runner = commandTesting.createExtensionCommandRunner(environment, context, run);

    await expect(runner("claude", ["mcp", "list"])).rejects.toThrow("The environment is not available");
    expect(calls).toEqual([]);
  });

  test("reports every agent as unreadable when the environment cannot be reached", async () => {
    const environment = createEnvironment({
      id: "env-nowhere",
      environmentType: "local",
      worktreePath: undefined,
      containerId: null,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    const catalogs = await commands.get("get_environment_extensions")?.(
      { environmentId: "env-nowhere" },
      context,
    ) as Array<Record<string, unknown>>;

    expect(catalogs.map((catalog) => catalog.agent)).toEqual(["claude", "codex", "opencode"]);
    for (const catalog of catalogs) {
      expect(catalog.mcpServers).toEqual([]);
      expect(catalog.plugins).toEqual([]);
      expect(catalog.mcpError).toBeTruthy();
      expect(catalog.pluginError).toBeTruthy();
    }
  });

  test("rejects an unknown environment", async () => {
    const { context } = createContext([]);
    const commands = createCommandRegistry();

    await expect(
      commands.get("get_environment_extensions")?.({ environmentId: "missing" }, context),
    ).rejects.toThrow("Environment not found: missing");
  });

  test("requires an environmentId", async () => {
    const { context } = createContext([]);
    const commands = createCommandRegistry();

    await expect(
      commands.get("get_environment_extensions")?.({}, context),
    ).rejects.toThrow(/environmentId/);
  });

  test("caches per environment so reopening the dialog does not respawn MCP servers", async () => {
    const environment = createEnvironment({
      id: "env-nowhere",
      environmentType: "local",
      worktreePath: undefined,
      containerId: null,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const lookups = context.storage.getEnvironment as unknown as { mock: { calls: unknown[] } };
    const lookupCount = () => lookups.mock.calls.length;

    await commands.get("get_environment_extensions")?.({ environmentId: "env-nowhere" }, context);
    const afterFirst = lookupCount();

    await commands.get("get_environment_extensions")?.({ environmentId: "env-nowhere" }, context);
    expect(lookupCount()).toBe(afterFirst);

    await commands.get("get_environment_extensions")?.(
      { environmentId: "env-nowhere", refresh: true },
      context,
    );
    expect(lookupCount()).toBe(afterFirst + 1);
  });

  test("drops the cached catalog when the environment is stopped", async () => {
    const environment = createEnvironment({
      id: "env-nowhere",
      environmentType: "local",
      worktreePath: undefined,
      containerId: null,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const lookups = context.storage.getEnvironment as unknown as { mock: { calls: unknown[] } };

    await commands.get("get_environment_extensions")?.({ environmentId: "env-nowhere" }, context);
    await commands.get("stop_environment")?.({ environmentId: "env-nowhere" }, context);
    const beforeReread = lookups.mock.calls.length;

    await commands.get("get_environment_extensions")?.({ environmentId: "env-nowhere" }, context);

    expect(lookups.mock.calls.length).toBe(beforeReread + 1);
  });

  test("does not cache a failed lookup", async () => {
    const { context } = createContext([]);
    const commands = createCommandRegistry();
    const lookups = context.storage.getEnvironment as unknown as { mock: { calls: unknown[] } };

    await expect(
      commands.get("get_environment_extensions")?.({ environmentId: "missing" }, context),
    ).rejects.toThrow("Environment not found: missing");
    const afterFirst = lookups.mock.calls.length;

    await expect(
      commands.get("get_environment_extensions")?.({ environmentId: "missing" }, context),
    ).rejects.toThrow("Environment not found: missing");

    expect(lookups.mock.calls.length).toBe(afterFirst + 1);
  });
});
