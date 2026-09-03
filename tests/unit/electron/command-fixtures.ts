import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { execFile, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

import { createHash, randomUUID } from "node:crypto";

import { existsSync, promises as fs, readFileSync } from "node:fs";

import http from "node:http";

import os from "node:os";

import path from "node:path";

import { pathToFileURL } from "node:url";

import { promisify } from "node:util";

import {
  isPaneLayoutRevisionConflict,
  paneLayoutRevisionConflictMessage,
} from "@orkestrator/protocol/pane-layout";

import { UNATTENDED_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";

import {
  isLoopedReviewWorkflow,
  isReviewPackageReference,
  LOOPED_REVIEW_WORKFLOW_VERSION,
} from "@orkestrator/protocol/review-workflow";

import { spawnCommand } from "../../../apps/backend/src/core/shell";

import type { Environment, RepositoryConfig } from "../../../apps/backend/src/core/models";

import type { CommandContext } from "../../../apps/backend/src/core/commands";

import { APP_SLUG, APP_VERSION } from "../../../apps/backend/src/core/constants";

import { dockerOwnerNamespace } from "../../../apps/backend/src/core/docker-ownership";

import { EnvironmentLifecycleTaskTracker } from "../../../apps/backend/src/core/environment-lifecycle-tasks";

type MockPtyProcess = {
  write: ReturnType<typeof mock>;
  resize: ReturnType<typeof mock>;
  kill: ReturnType<typeof mock>;
  emitData: (data: string) => void;
  emitExit: (event?: { exitCode: number; signal?: number }) => void;
};

type PtyExitEvent = { exitCode: number; signal?: number };

export async function createCommandFixtures() {
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
    resolveFileManagerRevealCommands,
    shutdownDiffStatsTracking,
    shutdownLocalServers,
    shutdownPrMonitorTracking,
    toClientEnvironment,
  } = await import("../../../apps/backend/src/core/commands");

  const { CommandFailedError } = await import("../../../apps/backend/src/core/shell");

  const { setAgentSkillsHomeForTesting } =
    await import("../../../apps/backend/src/core/agent-skills");

  const tempDirs: string[] = [];

  const SETUP_DONE_OSC = "\u001b]9999;setup_done\u0007";

  const SETUP_FAILED_OSC = "\u001b]9999;setup_failed\u0007";

  const TERMINAL_ACTIVITY_SETTLE_TEST_WAIT_MS = 850;

  function terminalSessionResult(value: unknown): { sessionId: string; created: boolean } {
    return value as { sessionId: string; created: boolean };
  }

  function framedContainerGitStatus(nameStatus = "", numstat = "", untracked = ""): string {
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
   * The smallest workflow that carries a generated package.
   *
   * `generate_looped_review_package` is only ever consumed by the looped-review
   * service, which validates the whole snapshot before it saves. A package that
   * matches its own shape assertions but fails that guard is unpersistable, and
   * the round dies at `package` — so the guard is what the generator's tests have
   * to assert against, not the shape alone.
   */
  function loopedReviewWorkflowAround(
    reviewPackage: Record<string, unknown>,
    options: { round: number; targetBranch: string },
  ): Record<string, unknown> {
    const timestamp = "2026-08-08T00:00:00.000Z";
    return {
      version: LOOPED_REVIEW_WORKFLOW_VERSION,
      controller: "backend",
      id: "workflow-1",
      environmentId: "env-1",
      projectId: "project-1",
      agent: "opencode",
      model: "opencode-go/deepseek-v4-flash",
      targetBranch: options.targetBranch,
      startingAllowance: 6,
      currentAllowance: 6,
      currentRound: options.round,
      currentPass: 0,
      phase: "discovering",
      rounds: [
        {
          round: options.round,
          allowance: 6,
          status: "reviewing",
          passes: [],
          startedAt: timestamp,
          package: reviewPackage,
        },
      ],
      activePool: { issues: [], coverageGaps: [] },
      archivedPools: [],
      sessions: [],
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      pr: { status: "pending" },
      createdAt: timestamp,
      updatedAt: timestamp,
      backendRevision: 3,
    };
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
    await execFileAsync("git", [
      "-C",
      worktreePath,
      "config",
      "user.email",
      "test@example.invalid",
    ]);
    await execFileAsync("git", ["-C", worktreePath, "config", "user.name", "Test"]);
    await fs.writeFile(path.join(worktreePath, "review.txt"), "before\n");
    await execFileAsync("git", ["-C", worktreePath, "add", "review.txt"]);
    await execFileAsync("git", ["-C", worktreePath, "commit", "-m", "base"]);
    await execFileAsync("git", ["-C", worktreePath, "branch", "-M", "main"]);
    const { stdout: baseOutput } = await execFileAsync("git", [
      "-C",
      worktreePath,
      "rev-parse",
      "HEAD",
    ]);
    const baseRef = baseOutput.trim();
    await execFileAsync("git", [
      "-C",
      worktreePath,
      "update-ref",
      "refs/remotes/origin/main",
      baseRef,
    ]);
    await execFileAsync("git", ["-C", worktreePath, "checkout", "-b", "feature/local"]);
    const content = "after\n";
    await fs.writeFile(path.join(worktreePath, "review.txt"), content);
    const extraNames = Object.keys(options.extraCommittedFiles ?? {});
    for (const name of extraNames) {
      await fs.writeFile(path.join(worktreePath, name), options.extraCommittedFiles![name]);
    }
    await execFileAsync("git", ["-C", worktreePath, "add", "review.txt", ...extraNames]);
    await execFileAsync("git", ["-C", worktreePath, "commit", "-m", "change"]);
    const { stdout: headOutput } = await execFileAsync("git", [
      "-C",
      worktreePath,
      "rev-parse",
      "HEAD",
    ]);
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
      project?: {
        id: string;
        name: string;
        gitUrl: string;
        localPath: string | null;
        addedAt: string;
        order: number;
      };
      repositoryConfig?: RepositoryConfig;
      globalConfig?: Record<string, unknown>;
      cacheAgentModelCatalog?: (
        agent: "claude" | "codex" | "cursor" | "grok",
        models: unknown[],
      ) => Promise<unknown>;
      dataDir?: string;
    } = {},
  ): {
    context: CommandContext;
    updates: Array<Record<string, unknown>>;
    emitted: Array<{ event: string; payload: unknown }>;
  } {
    const environments = Array.isArray(environmentOrEnvironments)
      ? environmentOrEnvironments
      : [environmentOrEnvironments];
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
    let desktopConnections = {
      activeConnectionId: "local",
      connections: [] as Array<Record<string, unknown>>,
    };
    const context = {
      appRoot: "",
      resourceRoot: "",
      environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
      emit: mock((event: string, payload: unknown) => {
        emitted.push({ event, payload });
      }),
      storage: {
        getDataDir: () => options.dataDir ?? path.join(os.tmpdir(), "orkestrator-command-tests"),
        withGitHubCompletionCommentLock: mock(
          async (_pipelineId: string, operation: () => Promise<unknown>) => operation(),
        ),
        loadConfig: mock(async () => config),
        saveConfig: mock(async (nextConfig: typeof config) => {
          Object.assign(config, nextConfig);
        }),
        updateRepositoryConfig: mock(async (projectId: string, nextConfig: RepositoryConfig) => {
          config.repositories[projectId as "project-1"] = nextConfig;
          return config;
        }),
        updateRepositorySettings: mock(async (projectId: string, nextConfig: RepositoryConfig) => {
          const current = config.repositories[projectId as "project-1"];
          config.repositories[projectId as "project-1"] = {
            ...nextConfig,
            ...(current?.lastEnvironmentType !== undefined
              ? { lastEnvironmentType: current.lastEnvironmentType }
              : {}),
            ...(current?.lastEnvironmentAgentSelection !== undefined
              ? {
                  lastEnvironmentAgentSelection: current.lastEnvironmentAgentSelection,
                }
              : {}),
          };
          return config;
        }),
        patchRepositoryConfig: mock(
          async (projectId: string, updates: Partial<RepositoryConfig>) => {
            config.repositories[projectId as "project-1"] = {
              ...repositoryConfig,
              ...config.repositories[projectId as "project-1"],
              ...updates,
            };
            return config;
          },
        ),
        getDesktopConnections: mock(async () => desktopConnections),
        saveDesktopConnections: mock(async (nextConnections: typeof desktopConnections) => {
          desktopConnections = nextConnections;
        }),
        cacheAgentModelCatalog: mock(
          options.cacheAgentModelCatalog ?? (async () => ({ schemaVersion: 1 as const })),
        ),
        getAgentModelCatalogCache: mock(async () => ({ schemaVersion: 1 as const })),
        getOpenCodeModelCatalog: mock(async () => null),
        getEnvironment: mock(
          async (environmentId: string) =>
            environments.find((environment) => environment.id === environmentId) ?? null,
        ),
        getEnvironmentsByProject: mock(async (projectId: string) =>
          environments.filter((environment) => environment.projectId === projectId),
        ),
        loadEnvironments: mock(async () => environments),
        addEnvironment: mock(async (environment: Environment) => {
          environment.order =
            Math.max(
              -1,
              ...environments
                .filter((item) => item.projectId === environment.projectId)
                .map((item) => item.order),
            ) + 1;
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
        deleteMultiReviewWorkflowsByEnvironment: mock(async () => undefined),
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

  const LOCAL_PROJECT_FOR_CREATE = {
    id: "project-1",
    name: "Project",
    gitUrl: "https://github.com/acme/project.git",
    localPath: process.cwd(),
    addedAt: new Date(0).toISOString(),
    order: 0,
  };

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
      ${
        environmentMarkerPath
          ? `require("node:fs").writeFileSync(${JSON.stringify(environmentMarkerPath)}, process.env.${bridgeName === "claude-bridge" ? "CLAUDE_CLI_PATH" : "CODEX_PATH"} ?? "");`
          : ""
      }
      ${
        versionMarkerPath
          ? `require("node:fs").writeFileSync(${JSON.stringify(versionMarkerPath)}, process.env.ORKESTRATOR_VERSION ?? "");`
          : ""
      }
      ${
        maxConcurrentThreadsMarkerPath
          ? `require("node:fs").writeFileSync(${JSON.stringify(maxConcurrentThreadsMarkerPath)}, process.env.CODEX_MAX_CONCURRENT_THREADS_PER_SESSION ?? "");`
          : ""
      }
      http.createServer((req, res) => {
        if (req.url === "/global/health") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        ${
          modelCatalog
            ? `if (req.url === "/config/models") {
          res.writeHead(200, {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
          });
          res.end(${JSON.stringify(JSON.stringify(modelCatalog))});
          return;
        }`
            : ""
        }
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
      close: () =>
        new Promise<void>((resolve, reject) => {
          // Dropping keep-alive sockets can already stop the listener, so a
          // "not running" close is success rather than a leaked port.
          server.closeAllConnections();
          server.close((error) =>
            !error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING"
              ? resolve()
              : reject(error),
          );
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
          request.headers.authorization || request.headers["x-orkestrator-claude-token"];
        response.writeHead(suppliedCredential && !options.isAuthorized(request) ? 401 : 200);
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
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) =>
            !error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING"
              ? resolve()
              : reject(error),
          );
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
      const request = http.get(
        {
          host: "127.0.0.1",
          port,
          path: requestPath,
          timeout: 2_000,
          headers,
        },
        (response) => {
          response.resume();
          resolve((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300);
        },
      );
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

  // `git config --get` exits non-zero for a key that is not set, and an absent
  // upstream is exactly what these tests assert, so a missing key reads as "".
  async function configuredGitUpstream(
    repo: string,
    branch: string,
  ): Promise<{
    remote: string;
    merge: string;
  }> {
    return {
      remote: await gitOutput(repo, ["config", "--get", `branch.${branch}.remote`]).catch(() => ""),
      merge: await gitOutput(repo, ["config", "--get", `branch.${branch}.merge`]).catch(() => ""),
    };
  }

  async function configuredGitPushBehaviour(repo: string): Promise<{
    pushDefault: string;
    autoSetupRemote: string;
  }> {
    return {
      pushDefault: await gitOutput(repo, ["config", "--get", "push.default"]).catch(() => ""),
      autoSetupRemote: await gitOutput(repo, ["config", "--get", "push.autoSetupRemote"]).catch(
        () => "",
      ),
    };
  }

  function expectedManagedWorktreePath(projectName: string, branch: string): string {
    return path.join(os.homedir(), APP_SLUG, "workspaces", `${projectName}-${branch}`);
  }

  async function expectLocalWorktreeRolledBack(
    projectPath: string,
    worktreePath: string,
    branch: string,
  ): Promise<void> {
    expect(existsSync(worktreePath)).toBe(false);

    const { stdout: branches } = await execFileAsync("git", [
      "-C",
      projectPath,
      "branch",
      "--list",
      branch,
    ]);
    expect(branches.trim()).toBe("");

    const { stdout: worktrees } = await execFileAsync("git", [
      "-C",
      projectPath,
      "worktree",
      "list",
      "--porcelain",
    ]);
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

  async function withFakeDocker(
    scriptBody: string,
    run: (logs: { all: string; rm: string; exec: string; home: string }) => Promise<void>,
    // Starting a container syncs the host's Claude Code credential into it. On
    // macOS that reads the login Keychain; everywhere else — and on macOS whenever
    // the Keychain lookup fails — it reads `~/.claude/.credentials.json`. Stubbing
    // only `security` would leave that second path pointed at the developer's real
    // home, so `HOME` is redirected too (see below). Exit 1 is what `security`
    // reports for a missing item, so the default stub falls through to the (empty)
    // fake home and the lookup yields nothing on every platform.
    securityScriptBody = "#!/bin/sh\nexit 1\n",
    // Contents to seed at `$HOME/.claude/.credentials.json` in the fake home.
    // Supplying this is how a test exercises the non-darwin resolution path.
    claudeCredentialsOnDisk?: string,
  ): Promise<void> {
    const root = await createTempDir("ork-electron-fake-docker-");
    const binDir = path.join(root, "bin");
    const home = path.join(root, "home");
    const all = path.join(root, "docker.log");
    const rm = path.join(root, "docker-rm.log");
    const exec = path.join(root, "docker-exec.log");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(binDir, "docker"), scriptBody);
    await fs.chmod(path.join(binDir, "docker"), 0o755);
    await fs.writeFile(path.join(binDir, "security"), securityScriptBody);
    await fs.chmod(path.join(binDir, "security"), 0o755);
    if (claudeCredentialsOnDisk !== undefined) {
      await fs.mkdir(path.join(home, ".claude"), { recursive: true });
      await fs.writeFile(path.join(home, ".claude", ".credentials.json"), claudeCredentialsOnDisk);
    }

    const originalPath = process.env.PATH;
    const originalHome = process.env.HOME;
    const originalDockerLog = process.env.FAKE_DOCKER_LOG;
    const originalDockerRmLog = process.env.FAKE_DOCKER_RM_LOG;
    const originalDockerExecLog = process.env.FAKE_DOCKER_EXEC_LOG;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    // `os.homedir()` honours $HOME on POSIX, which is what `getHostClaudeCredentials`
    // resolves against. Redirecting it keeps the developer's real credential out of
    // the fake-docker logs written under /tmp, and makes every home-derived path in
    // these tests hermetic rather than dependent on the machine running them.
    process.env.HOME = home;
    process.env.FAKE_DOCKER_LOG = all;
    process.env.FAKE_DOCKER_RM_LOG = rm;
    process.env.FAKE_DOCKER_EXEC_LOG = exec;

    try {
      await run({ all, rm, exec, home });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
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
    await fs.writeFile(
      path.join(binDir, "git"),
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = '${subcommand.replaceAll("'", "'\\''")}' ]; then
    printf '%s\\n' '${output.replaceAll("'", "'\\''")}'
    exit 0
  fi
done
exec '${realGit}' "$@"
`,
    );
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
    await fs.writeFile(
      path.join(binDir, "base64"),
      `#!/bin/sh
if printf '' | '${realBase64}' -w0 >/dev/null 2>&1; then
  exec '${realBase64}' "$@"
fi
if [ "$1" = "-w0" ]; then shift; fi
exec '${realBase64}' "$@"
`,
    );
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
    await fs.writeFile(
      path.join(binDir, "git"),
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = '${subcommand.replaceAll("'", "'\\''")}' ]; then
    printf '%s\\n' "$*" >> '${logPath.replaceAll("'", "'\\''")}'
    break
  fi
done
exec '${realGit}' "$@"
`,
    );
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

  async function withFailingGitSubcommand(
    subcommand: string,
    run: () => Promise<void>,
    message = `forced ${subcommand} failure`,
  ): Promise<void> {
    const root = await createTempDir("ork-electron-fake-git-");
    const binDir = path.join(root, "bin");
    const { stdout } = await execFileAsync("which", ["git"]);
    const realGit = stdout.trim().replaceAll("'", "'\\''");
    await fs.mkdir(binDir, { recursive: true });
    const escapedMessage = message.replaceAll("'", "'\\''");
    await fs.writeFile(
      path.join(binDir, "git"),
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = '${subcommand.replaceAll("'", "'\\''")}' ]; then
    printf '%s\\n' '${escapedMessage}' >&2
    exit 42
  fi
done
exec '${realGit}' "$@"
`,
    );
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
   * Run with a `git` shim whose `case` body decides, per invocation, what to do
   * with the joined arguments in `$*`. Each branch may run `real_git "$@"` first,
   * which is how a test reproduces a command that took effect and still reported
   * failure (a timeout, a killed `docker exec`). Anything the body does not match
   * falls through to the real git.
   */
  async function withGitArgumentStub(caseBody: string, run: () => Promise<void>): Promise<void> {
    const root = await createTempDir("ork-electron-git-stub-");
    const binDir = path.join(root, "bin");
    const { stdout } = await execFileAsync("which", ["git"]);
    const realGit = stdout.trim().replaceAll("'", "'\\''");
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(
      path.join(binDir, "git"),
      `#!/bin/sh
real_git() {
  '${realGit}' "$@"
}
case "$*" in
${caseBody}
esac
exec '${realGit}' "$@"
`,
    );
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

  async function withFakeGh(
    scriptBody: string,
    run: (logPath: string) => Promise<void>,
  ): Promise<void> {
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

  async function withFakeCodex(
    scriptBody: string,
    run: (logPath: string) => Promise<void>,
  ): Promise<void> {
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
    return (
      ["/bin/zsh", "/bin/bash", "/bin/sh"].find((candidate) => existsSync(candidate)) ??
      configuredShell ??
      "zsh"
    );
  }

  const ASYNC_TEST_WAIT_TIMEOUT_MS = 10_000;

  /**
   * Per-test budget for the tests that use the wait helpers below.
   *
   * Bun's default is 5s, which two of these tests can exhaust on their own: they
   * await a helper twice, so the worst case is 2 x ASYNC_TEST_WAIT_TIMEOUT_MS
   * before any fixture setup is counted. Without an explicit budget a slow run
   * dies on Bun's generic "timed out after 5000ms" instead of the helper's message
   * naming the condition that never became true.
   */
  const ASYNC_TEST_BUDGET_MS = 30_000;

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
      setAgentSkillsHomeForTesting(undefined);
      shutdownDiffStatsTracking();
      // Commands like set_environment_pr arm PR monitoring as a side effect;
      // dropping the entries here keeps a scheduled poll from spawning `gh`
      // against a fixture worktree later in the run.
      shutdownPrMonitorTracking();
      commandTesting.resetLocalServerLifecycle();
      commandTesting.resetDockerContainerStateCache();
      commandTesting.resetTerminalOutputBuffers();
      await Promise.all(
        tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
      );
      showOpenDialog.mockClear();
      ptySpawn.mockClear();
      ptyProcesses.splice(0);
    }
  });

  afterAll(async () => {
    const commands = createCommandRegistry();
    await commands.get("stop_local_codex_server_cmd")?.(
      { environmentId: "env-local" },
      createContext(createEnvironment()).context,
    );
  });

  return {
    APP_SLUG,
    APP_VERSION,
    ASYNC_TEST_BUDGET_MS,
    ASYNC_TEST_WAIT_TIMEOUT_MS,
    CONTAINER_UNTRACKED_STATS_SCANNER,
    CommandFailedError,
    ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES,
    EnvironmentLifecycleTaskTracker,
    LOCAL_PROJECT_FOR_CREATE,
    LOOPED_REVIEW_WORKFLOW_VERSION,
    RUNNING_CONTAINER_DOCKER_SCRIPT,
    SETUP_DONE_OSC,
    SETUP_FAILED_OSC,
    TERMINAL_ACTIVITY_SETTLE_TEST_WAIT_MS,
    UNATTENDED_AGENT_INTERACTION_POLICY,
    afterAll,
    afterEach,
    closeLocalServerAdmission,
    codexSlugScript,
    commandTesting,
    configuredGitPushBehaviour,
    configuredGitUpstream,
    createCommandRegistry,
    createContext,
    createDeferred,
    createEnvironment,
    createFakeChild,
    createGitRepoOnBranch,
    createGitWorktreeWithOrigin,
    createHash,
    createReviewPackageWorktree,
    createTempDir,
    currentGitBranch,
    currentGitCommit,
    describe,
    dockerOwnerNamespace,
    execFile,
    execFileAsync,
    existsSync,
    expect,
    expectClearsPendingAgentLaunch,
    expectLocalWorktreeRolledBack,
    expectedLocalShellPath,
    expectedManagedWorktreePath,
    framedContainerGitStatus,
    freshFetchedAt,
    fs,
    gitOutput,
    http,
    isImmutableCommitRef,
    isLoopedReviewWorkflow,
    isReviewPackageReference,
    isPaneLayoutRevisionConflict,
    isProcessRunning,
    isolateCodexBinaryLookup,
    liveDockerTest,
    loopedReviewWorkflowAround,
    mock,
    os,
    paneLayoutRevisionConflictMessage,
    path,
    pathToFileURL,
    promisify,
    ptyProcesses,
    ptySpawn,
    randomUUID,
    readFileSync,
    readTestCredential,
    requestOk,
    reserveFreePort,
    resolveBrowserOpenCommand,
    resolveFileManagerRevealCommands,
    runGit,
    setAgentSkillsHomeForTesting,
    showOpenDialog,
    shutdownDiffStatsTracking,
    shutdownLocalServers,
    shutdownPrMonitorTracking,
    spawnCommand,
    spawnSync,
    spyOn,
    startAuthenticatedContainerServer,
    startControllableHealthServer,
    tempDirs,
    terminalSessionResult,
    test,
    toClientEnvironment,
    updatesWithStatus,
    waitForCondition,
    waitForPtyProcessCount,
    withFailingGitSubcommand,
    withFakeCodex,
    withFakeDocker,
    withFakeGh,
    withFakeGitSubcommandOutput,
    withFixedDate,
    withGitArgumentStub,
    withGitSubcommandLog,
    withGnuBase64Shim,
    writeBridgeEntrypoint,
    writeBridgeServer,
  };
}

export type {
  ChildProcessWithoutNullStreams,
  CommandContext,
  Environment,
  MockPtyProcess,
  PtyExitEvent,
  RepositoryConfig,
};
