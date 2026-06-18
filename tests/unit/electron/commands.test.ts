import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Environment } from "../../../electron/backend/models";
import type { CommandContext } from "../../../electron/backend/commands";

const execFileAsync = promisify(execFile);

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
  emitExit: () => void;
};

const ptyProcesses: MockPtyProcess[] = [];
const ptySpawn = mock((command: string, args: string[], options: Record<string, unknown>) => {
  const dataCallbacks: Array<(data: string) => void> = [];
  const exitCallbacks: Array<() => void> = [];
  const process: MockPtyProcess = {
    write: mock(() => undefined),
    resize: mock(() => undefined),
    kill: mock(() => undefined),
    emitData: (data: string) => dataCallbacks.forEach((callback) => callback(data)),
    emitExit: () => exitCallbacks.forEach((callback) => callback()),
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

mock.module("node-pty", () => ({ spawn: ptySpawn }));

const { createCommandRegistry } = await import("../../../electron/backend/commands");

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
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

function createContext(environmentOrEnvironments: Environment | Environment[]): {
  context: CommandContext;
  updates: Array<Record<string, unknown>>;
  emitted: Array<{ event: string; payload: unknown }>;
} {
  const environments = Array.isArray(environmentOrEnvironments) ? environmentOrEnvironments : [environmentOrEnvironments];
  const updates: Array<Record<string, unknown>> = [];
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const context = {
    appRoot: "",
    resourceRoot: "",
    emit: mock((event: string, payload: unknown) => {
      emitted.push({ event, payload });
    }),
    storage: {
      getEnvironment: mock(async (environmentId: string) => environments.find((environment) => environment.id === environmentId) ?? null),
      getEnvironmentsByProject: mock(async (projectId: string) => environments.filter((environment) => environment.projectId === projectId)),
      loadEnvironments: mock(async () => environments),
      updateEnvironment: mock(async (environmentId: string, update: Record<string, unknown>) => {
        const environment = environments.find((candidate) => candidate.id === environmentId);
        if (!environment) throw new Error(`Environment not found: ${environmentId}`);
        updates.push(update);
        Object.assign(environment, update);
        return environment;
      }),
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
  test("registers every command exposed by the typed frontend wrapper", async () => {
    const source = await fs.readFile(path.join(process.cwd(), "src", "lib", "tauri.ts"), "utf8");
    const exposedCommands = Array.from(source.matchAll(/invoke(?:<[^>]+>)?\("([^"]+)"/g), (match) => match[1]);
    const commands = createCommandRegistry();

    for (const command of exposedCommands) {
      expect(commands.has(command)).toBe(true);
    }
  });

  test("opens a directory picker through the Electron dialog command", async () => {
    const commands = createCommandRegistry();
    await expect(commands.get("browse_for_directory")?.({}, createContext(createEnvironment()).context)).resolves.toBe("/tmp/project");
    expect(showOpenDialog).toHaveBeenCalledWith({ properties: ["openDirectory"] });
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
      expect(codexLog).toContain("exec --skip-git-repo-check --ephemeral --ignore-rules --sandbox read-only");
      expect(codexLog).toContain("--output-last-message");
      expect(codexLog).not.toContain("claude");
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
    ) as Array<{ path: string; additions: number; deletions: number; status: string }>;

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
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42" ] && [ "$3" = "--method" ] && [ "$4" = "PUT" ]; then
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
      expect(ghLog).toContain("api repos/acme/repo/pulls/42 --method PUT -f merge_method=squash");
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
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42" ] && [ "$3" = "--method" ] && [ "$4" = "PUT" ]; then
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
      expect(ghLog).toContain("api repos/acme/repo/pulls/42 --method PUT -f merge_method=rebase");
      expect(ghLog).toContain("api repos/acme/repo/git/refs/heads/feature/local-work --method DELETE");
      expect(ghLog).not.toContain("pr merge");
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
    const environment = createEnvironment({ worktreePath });
    const { context, emitted } = createContext(environment);
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
      name: "xterm-256color",
      cols: 132,
      rows: 43,
      cwd: worktreePath,
    });

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
      name: "xterm-256color",
      cols: 100,
      rows: 32,
    });
  });
});
