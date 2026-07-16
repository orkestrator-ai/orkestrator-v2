import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Environment, RepositoryConfig } from "../../../apps/backend/src/core/models";
import type { CommandContext } from "../../../apps/backend/src/core/commands";
import { APP_SLUG } from "../../../apps/backend/src/core/constants";

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

const { createCommandRegistry, resolveBrowserOpenCommand } = await import("../../../apps/backend/src/core/commands");

const tempDirs: string[] = [];
const SETUP_DONE_OSC = "\u001b]9999;setup_done\u0007";
const SETUP_FAILED_OSC = "\u001b]9999;setup_failed\u0007";

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
    global: {},
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
    emit: mock((event: string, payload: unknown) => {
      emitted.push({ event, payload });
    }),
    storage: {
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
      removeEnvironment: mock(async (environmentId: string) => {
        const index = environments.findIndex((candidate) => candidate.id === environmentId);
        if (index >= 0) environments.splice(index, 1);
      }),
      removeSessionsByEnvironment: mock(async () => undefined),
      deletePaneLayout: mock(async () => undefined),
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

async function writeBridgeServer(appRoot: string, bridgeName: "claude-bridge" | "codex-bridge"): Promise<void> {
  const bridgeDist = path.join(appRoot, "bridges", bridgeName, "dist");
  await fs.mkdir(bridgeDist, { recursive: true });
  await fs.writeFile(
    path.join(bridgeDist, "index.js"),
    `
      const http = require("node:http");
      const port = Number(process.env.PORT);
      http.createServer((req, res) => {
        if (req.url === "/global/health") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404);
        res.end();
      }).listen(port, "127.0.0.1");
    `,
  );
}

async function requestOk(port: number, requestPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: requestPath, timeout: 2_000 }, (response) => {
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

// Points the codex binary lookup at an empty dir so `resolveCodexBinary` falls back to the
// fake `codex` on PATH instead of the real binary bundled at `binaries/codex`.
async function isolateCodexBinaryLookup(context: CommandContext): Promise<void> {
  const root = await createTempDir("ork-codex-root-");
  context.appRoot = root;
  context.resourceRoot = root;
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

async function waitForPtyProcessCount(count: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 1_000) {
    if (ptyProcesses.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${count} PTY process(es), saw ${ptyProcesses.length}`);
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
    *rev-parse*)
      printf '1111111111111111111111111111111111111111\\n'
      ;;
  esac
  exit 0
fi
exit 0
`;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  showOpenDialog.mockClear();
  ptySpawn.mockClear();
  ptyProcesses.splice(0);
});

afterAll(async () => {
  const commands = createCommandRegistry();
  await commands.get("stop_local_codex_server_cmd")?.({ environmentId: "env-local" }, createContext(createEnvironment()).context);
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
      await expect(fs.readFile(logPath, "utf8")).rejects.toThrow();
    });
  });

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
    await expect(commands.get("get_environments")?.({ projectId: environment.projectId }, context)).resolves.toEqual([environment]);
    expect(updates).toHaveLength(0);
  });

  test("returns read-only environment snapshots without invoking Docker reconciliation", async () => {
    const environment = createEnvironment({
      status: "running",
      containerId: "container-existing",
      environmentType: "containerized",
    });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();

    await expect(commands.get("get_environment_snapshots")?.(
      { projectId: environment.projectId },
      context,
    )).resolves.toEqual([environment]);
    expect(updates).toHaveLength(0);
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
      )).resolves.toEqual([environment]);
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
      expect(execLog).toContain("git -C /workspace rev-parse HEAD");
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
        .map((entry) => Buffer.from(entry.payload as number[]).toString("utf8"))
        .join("");
      expect(setupOutput).toContain("[orkestrator] Starting environment setup");
      expect(setupOutput).toContain("/usr/local/bin/workspace-setup.sh");
      expect(emitted).toContainEqual({
        event: "environment-setup-started",
        payload: {
          environment_id: environment.id,
          session_id: `${environment.id}:setup`,
          environment,
        },
      });
      expect(emitted).toContainEqual({
        event: "environment-setup-complete",
        payload: {
          environment_id: environment.id,
          success: true,
          environment: updated,
        },
      });
    });
  });

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

      expect(result).toBe(environment);
      expect(emitted).toEqual([]);
    });
  });

  test("ensures no-op local setup without spawning a terminal", async () => {
    const worktreePath = await createTempDir("ork-electron-local-noop-setup-");
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
      setupCommands: [],
      setupManagedByBackend: true,
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

  test("emits a failure event when inactive container setup fails", async () => {
    const environment = createEnvironment({
      id: "env-container-setup-fails",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
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
  printf 'setup exploded\n' >&2
  exit 9
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
      expect(emitted).toContainEqual({
        event: "environment-setup-complete",
        payload: {
          environment_id: environment.id,
          success: false,
          error: "Setup script failed",
        },
      });
    });
  });

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
  });

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
      expect(emitted).toContainEqual({
        event: "environment-setup-complete",
        payload: {
          environment_id: environment.id,
          success: false,
          error: "Setup terminal exited before reporting completion",
        },
      });
    });
  });

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
  });

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
    });
  });

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

      expect(context.storage.deletePaneLayout).toHaveBeenCalledWith(environment.id);

      expect(
        await commands.get("get_environment_setup_session")?.({ environmentId: environment.id }, context),
      ).toBeNull();
      const buffer = await commands.get("get_terminal_output_buffer")?.(
        { sessionId: setupSessionId },
        context,
      ) as string;
      expect(buffer).toBe("");
    });
  });

  test("frees a non-setup terminal output buffer when the session exits", async () => {
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

    const sessionId = await commands.get("create_local_terminal_session")?.(
      { environmentId: environment.id, cols: 80, rows: 24 },
      context,
    ) as string;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);
    await waitForPtyProcessCount(1);

    ptyProcesses[0]?.emitData("hello from shell\r\n");
    const buffer = await commands.get("get_terminal_output_buffer")?.({ sessionId }, context) as string;
    expect(buffer).toContain("hello from shell");

    // One-shot terminal buffers must be freed on exit so they do not leak for
    // the lifetime of the main process.
    ptyProcesses[0]?.emitExit({ exitCode: 0 });
    const afterExit = await commands.get("get_terminal_output_buffer")?.({ sessionId }, context) as string;
    expect(afterExit).toBe("");
  });

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

    const sessionId = await commands.get("create_local_terminal_session")?.(
      { environmentId: environment.id, cols: 80, rows: 24 },
      context,
    ) as string;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);
    await waitForPtyProcessCount(1);

    ptyProcesses[0]?.emitData("A".repeat(maxChars));
    ptyProcesses[0]?.emitData("B".repeat(1024));
    const buffer = await commands.get("get_terminal_output_buffer")?.({ sessionId }, context) as string;
    expect(buffer.length).toBe(maxChars);
    expect(buffer.endsWith("B".repeat(1024))).toBe(true);
    expect(buffer.startsWith("A")).toBe(true);
  });

  test("captures container HEAD commit when frontend marks setup complete", async () => {
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
if [ "$1" = "exec" ]; then
  case "$*" in
    *rev-parse*)
      printf '2222222222222222222222222222222222222222\\n'
      ;;
  esac
  exit 0
fi
exit 0
`, async () => {
      const updated = await commands.get("set_environment_setup_complete")?.(
        { environmentId: environment.id, complete: true },
        context,
      ) as Environment;

      expect(updated.setupScriptsComplete).toBe(true);
      expect(updated.createdFromCommit).toBe("2222222222222222222222222222222222222222");
    });
  });

  test("does not throw when docker exec fails while capturing container HEAD commit", async () => {
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
    });
  });

  test("does not pass host gh auth token into newly created containers without configured token", async () => {
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
          setupCommands: [],
          setupManagedByBackend: true,
          setupStarted: true,
          setupSessionId: `${environment.id}:setup`,
        }));
        await waitForPtyProcessCount(1);
        expect(ptySpawn.mock.calls[0]?.[1].at(-1)).toContain("/usr/local/bin/workspace-setup.sh");
        ptyProcesses[0]?.emitData(SETUP_DONE_OSC);

        const ghCalls = await fs.readFile(ghLog, "utf8").catch(() => "");
        expect(ghCalls).toBe("");

        const dockerCalls = await fs.readFile(logs.all, "utf8");
        expect(dockerCalls).not.toContain("GITHUB_TOKEN=host-gh-token");
        expect(dockerCalls).not.toContain("GH_TOKEN=host-gh-token");
        expect(environment.containerId).toBe("container-created");
      });
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
        setupCommands: [],
        setupManagedByBackend: true,
        setupStarted: true,
      }));
      await waitForPtyProcessCount(1);
      ptyProcesses[0]?.emitData(SETUP_DONE_OSC);

      await expect(fs.readFile(`${logs.all}.container-copy-root`, "utf8")).resolves.toBe("{\"copied\":true}\n");
      await expect(fs.readFile(`${logs.all}.container-copy-nested`, "utf8")).resolves.toBe("{\"nested\":true}\n");
      await expect(fs.readFile(`${logs.all}.container-copy-dest`, "utf8")).resolves.toBe("container-copy-created:/project-files\n");
      expect(environment.containerId).toBe("container-copy-created");
    });
  });

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
        setupCommands: [],
        setupManagedByBackend: true,
        setupStarted: false,
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
        setupCommands: [],
        setupManagedByBackend: true,
        setupStarted: false,
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
        setupCommands: [],
        setupManagedByBackend: true,
        setupStarted: false,
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
        setupCommands: [],
        setupManagedByBackend: true,
        setupStarted: false,
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
        setupCommands: [],
        setupManagedByBackend: true,
        setupStarted: false,
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

  test("persists GitHub token propagation with container git config updates", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
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
  printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
  exit 0
fi
exit 0
`, async (logs) => {
      await expect(commands.get("propagate_github_token_to_containers")?.({ newToken: "token-value" }, context)).resolves.toEqual({
        updated: ["env-container"],
        failed: [],
      });

      const execLog = await fs.readFile(logs.exec, "utf8");
      expect(execLog).toContain("git config --global --list");
      expect(execLog).toContain("--remove-section");
      expect(execLog).toContain("url.https://x-access-token:token-value@github.com/.insteadOf");
      expect(execLog).toContain("https://github.com/");
      expect(execLog).toContain("git@github.com:");
      expect(execLog).not.toContain("export GH_TOKEN");
    });
  });

  test("clears persisted GitHub token rewrites when propagation receives an empty token", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
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
  printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
  exit 0
fi
exit 0
`, async (logs) => {
      await expect(commands.get("propagate_github_token_to_containers")?.({ newToken: "" }, context)).resolves.toEqual({
        updated: ["env-container"],
        failed: [],
      });

      const execLog = await fs.readFile(logs.exec, "utf8");
      expect(execLog).toContain("grep '^url\\.https://x-access-token:'");
      expect(execLog).toContain("--remove-section");
      expect(execLog).not.toContain(".insteadOf");
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

  test("redacts the GitHub token from propagation failure messages", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
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
  printf '%s\\n' "$*" >&2
  exit 1
fi
exit 0
`, async () => {
      const result = await commands.get("propagate_github_token_to_containers")?.(
        { newToken: "secret-token-123" },
        context,
      ) as { updated: string[]; failed: [string, string][] };

      expect(result.updated).toEqual([]);
      expect(result.failed).toHaveLength(1);
      const [, message] = result.failed[0]!;
      expect(message).not.toContain("secret-token-123");
      expect(message).toContain("***");
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

    await withFakeDocker(`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
if [ "$1" = "exec" ]; then
  printf 'M\ttracked.txt\n'
  exit 0
fi
exit 1
`, async (logs) => {
      await expect(commands.get("get_git_status")?.(
        { containerId: "container-1", targetBranch: "main" },
        context,
      )).resolves.toEqual([expect.objectContaining({ path: "tracked.txt", status: "M" })]);

      const dockerExec = await fs.readFile(logs.exec, "utf8");
      expect(dockerExec).toContain("git rev-parse --is-inside-work-tree");
      expect(dockerExec).toContain("git rev-parse --git-path info/exclude");
      expect(dockerExec).toContain('for pattern in ".orkestrator" ".claude/settings.local.json"; do');
      expect(dockerExec).toContain('grep -qxF "$pattern" "$exclude_file"');
      expect(dockerExec).toContain("tail -c 1");
      expect(dockerExec).toContain("git diff --name-status origin/'main'");
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

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "exec" ]; then
  printf 'R100\told name.ts\tnew name.ts\n'
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
        status: "R100",
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
      expect(execLog).not.toContain("gh pr view");
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
      )).resolves.toBeUndefined();

      const ghLog = await fs.readFile(logPath, "utf8");
      expect(ghLog).toContain("api repos/acme/repo/pulls/42/merge --method PUT -f merge_method=squash");
      expect(ghLog).not.toContain("pr merge");
      expect(ghLog).not.toContain("--delete-branch");
    });
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
      )).resolves.toBeUndefined();

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
      )).resolves.toBeUndefined();

      const ghLog = await fs.readFile(logPath, "utf8");
      expect(ghLog).toContain("api repos/acme/repo/pulls/42/merge --method PUT -f merge_method=squash");
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
      )).resolves.toBeUndefined();

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
    const worktreePath = await createTempDir("ork-electron-worktree-");
    await writeBridgeServer(appRoot, "codex-bridge");

    const environment = createEnvironment({ worktreePath });
    const { context, updates } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;

    const commands = createCommandRegistry();
    const result = await commands.get("start_local_codex_server_cmd")?.({ environmentId: environment.id }, context) as {
      port: number;
      pid: number;
      wasRunning: boolean;
    };

    expect(result.wasRunning).toBe(false);
    expect(result.port).toBeGreaterThan(0);
    expect(result.pid).toBeGreaterThan(0);
    expect(updates).toContainEqual({ localCodexPort: result.port, codexBridgePid: result.pid });
    await expect(requestOk(result.port, "/global/health")).resolves.toBe(true);

    await commands.get("stop_local_codex_server_cmd")?.({ environmentId: environment.id }, context);
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
    };

    try {
      expect(result.wasRunning).toBe(false);
      expect(result.port).toBeGreaterThan(0);
      await expect(requestOk(result.port, "/global/health")).resolves.toBe(true);
      expect(await fs.readFile(markerPath, "utf8")).toContain("used");
      expect(updates).toContainEqual({ localClaudePort: result.port, claudeBridgePid: result.pid });
    } finally {
      await commands.get("stop_local_claude_server_cmd")?.({ environmentId: environment.id }, context);
    }
  });

  test("launches the local opencode server through the bundled opencode binary in resources", async () => {
    const appRoot = await createTempDir("ork-electron-app-opencode-");
    const resourceRoot = await createTempDir("ork-electron-res-opencode-");
    const worktreePath = await createTempDir("ork-electron-worktree-opencode-");

    const markerPath = path.join(resourceRoot, "opencode-was-used.log");
    const opencodeWrapperDir = path.join(resourceRoot, "bin");
    const opencodeWrapperPath = path.join(opencodeWrapperDir, "opencode");
    await fs.mkdir(opencodeWrapperDir, { recursive: true });
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
exec env PORT_ARG="$PORT" HOST_ARG="$HOST" node -e 'const http = require("node:http"); const port = Number(process.env.PORT_ARG); const host = process.env.HOST_ARG || "127.0.0.1"; http.createServer((req, res) => { if (req.url === "/global/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); return; } res.writeHead(404); res.end(); }).listen(port, host);'
`,
    );
    await fs.chmod(opencodeWrapperPath, 0o755);

    const environment = createEnvironment({ worktreePath });
    const { context, updates } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = resourceRoot;

    const commands = createCommandRegistry();
    await expect(commands.get("check_opencode_cli")?.({}, context)).resolves.toBe(true);
    const result = await commands.get("start_local_opencode_server_cmd")?.({ environmentId: environment.id }, context) as {
      port: number;
      pid: number;
      wasRunning: boolean;
    };

    try {
      expect(result.wasRunning).toBe(false);
      expect(result.port).toBeGreaterThan(0);
      await expect(requestOk(result.port, "/global/health")).resolves.toBe(true);
      expect(await fs.readFile(markerPath, "utf8")).toContain("used serve --port");
      expect(updates).toContainEqual({ localOpencodePort: result.port, opencodePid: result.pid });
    } finally {
      await commands.get("stop_local_opencode_server_cmd")?.({ environmentId: environment.id }, context);
    }
  });

  test("starts in-container bridges with bun, not node", async () => {
    const hostPort = await reserveFreePort();
    const pidFile = path.join(await createTempDir("ork-bridge-pid-"), "pid");
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    const previousHostPort = process.env.FAKE_BRIDGE_HOST_PORT;
    const previousPidFile = process.env.FAKE_BRIDGE_PID_FILE;
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
    process.env.FAKE_BRIDGE_PID_FILE = pidFile;

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
    bun -e 'require("node:http").createServer((q,s)=>{s.writeHead(q.url==="/global/health"?200:404,{"content-type":"application/json"});s.end("{}")}).listen(Number(process.env.FAKE_BRIDGE_HOST_PORT),"127.0.0.1")' >/dev/null 2>&1 &
    printf '%s' "$!" > "$FAKE_BRIDGE_PID_FILE"
    exit 0 ;;
esac
exit 0
`;

    try {
      await withFakeDocker(dockerScript, async (logs) => {
        const result = await commands.get("start_claude_server")?.({ containerId: "container-1" }, context);
        expect(result).toEqual({ hostPort, wasRunning: false });

        const execLog = await fs.readFile(logs.exec, "utf8");
        expect(execLog).toContain("setsid bun /opt/claude-bridge/dist/index.js");
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

  test("starts local terminal sessions through a PTY and forwards byte payloads", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-");
    const resourceRoot = await createTempDir("ork-electron-terminal-res-");
    const packagedBinDir = path.join(resourceRoot, "bin");
    await fs.mkdir(packagedBinDir, { recursive: true });
    const environment = createEnvironment({ worktreePath });
    const { context, emitted } = createContext(environment);
    context.resourceRoot = resourceRoot;
    const commands = createCommandRegistry();

    const sessionId = await commands.get("create_local_terminal_session")?.(
      { environmentId: environment.id, cols: 132, rows: 43 },
      context,
    ) as string;
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
    expect(terminalProcessEnv?.PATH?.split(path.delimiter)[0]).toBe(packagedBinDir);

    ptyProcesses[0]?.emitData("ready\r\n");
    expect(emitted).toEqual([
      { event: `terminal-output-${sessionId}`, payload: Array.from(Buffer.from("ready\r\n", "utf8")) },
    ]);

    await commands.get("local_terminal_write")?.({ sessionId, data: "pwd\r" }, context);
    await commands.get("local_terminal_resize")?.({ sessionId, cols: 120, rows: 30 }, context);
    expect(ptyProcesses[0]?.write).toHaveBeenCalledWith("pwd\r");
    expect(ptyProcesses[0]?.resize).toHaveBeenCalledWith(120, 30);

    await commands.get("close_local_terminal_session")?.({ sessionId }, context);
    expect(ptyProcesses[0]?.kill).toHaveBeenCalled();
    expect(commands.get("get_terminal_session")?.({ sessionId }, context)).toEqual({ id: sessionId, running: false });
  });

  test("rejects local terminal start when the worktree path is missing", async () => {
    const missingWorktreePath = path.join(os.tmpdir(), `ork-missing-worktree-${Date.now()}`);
    const environment = createEnvironment({ worktreePath: missingWorktreePath });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    const sessionId = await commands.get("create_local_terminal_session")?.(
      { environmentId: environment.id, cols: 80, rows: 24 },
      context,
    ) as string;

    await expect(commands.get("start_local_terminal_session")?.({ sessionId }, context)).rejects.toThrow(
      `Local environment worktree does not exist: ${missingWorktreePath}`,
    );
    expect(ptySpawn).not.toHaveBeenCalled();
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

  test("starts container terminal sessions through docker exec in a PTY", async () => {
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();

    const sessionId = await commands.get("create_terminal_session")?.(
      { containerId: "container-1", cols: 100, rows: 32, user: "node" },
      context,
    ) as string;
    await commands.get("start_terminal_session")?.({ sessionId }, context);

    const spawnCall = ptySpawn.mock.calls[0];
    expect(spawnCall?.[0]).toBe("docker");
    expect(spawnCall?.[1]).toEqual(["exec", "-it", "--user", "node", "container-1", "zsh", "-l"]);
    expect(spawnCall?.[2]).toMatchObject({
      cols: 100,
      rows: 32,
    });
  });
});

describe("pane layout commands", () => {
  test("validates and forwards pane layout envelopes", async () => {
    const persisted = {
      version: 1,
      environmentId: "env-1",
      containerId: null,
      activePaneId: "default",
      root: { kind: "leaf", id: "default", tabs: [], activeTabId: null },
      updatedAt: new Date(0).toISOString(),
      revision: 1,
    };
    const getPaneLayout = mock(async () => persisted);
    const savePaneLayout = mock(async (environmentId: string, layout: Record<string, unknown>) => ({
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
        version: 1,
        containerId: null,
        activePaneId: "default",
        root,
      },
    }, context);

    expect(savePaneLayout).toHaveBeenCalledWith("env-1", {
      version: 1,
      containerId: null,
      activePaneId: "default",
      root,
    });
    await expect(commands.get("get_pane_layout")?.({ environmentId: "env-1" }, context))
      .resolves.toEqual(persisted);
    expect(getPaneLayout).toHaveBeenCalledWith("env-1");
    await expect(commands.get("delete_pane_layout")?.({ environmentId: "env-1" }, context))
      .resolves.toBeUndefined();
    expect(deletePaneLayout).toHaveBeenCalledWith("env-1");
    await expect(commands.get("save_pane_layout")?.({
      environmentId: "env-1",
      layout: { version: 2, containerId: null, activePaneId: "default", root },
    }, context)).rejects.toThrow("Unsupported pane layout version");
    await expect(commands.get("save_pane_layout")?.({
      environmentId: "env-1",
      layout: { version: 1, containerId: null, activePaneId: "", root },
    }, context)).rejects.toThrow("non-empty");
    await expect(commands.get("save_pane_layout")?.({
      environmentId: "env-1",
      layout: { version: 1, containerId: null, activePaneId: "default", root: [] },
    }, context)).rejects.toThrow("layout.root");
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

    expect(storage.appendFeaturePlanMessage).toHaveBeenCalledWith("feature-1", "assistant", "hello");
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
