import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PUBLIC_ACTIONS,
  PUBLIC_API_SCHEMA_VERSION,
  type PublicActionName,
  type PublicActionResponse,
} from "@orkestrator/protocol/public-api";
import type { CommandContext } from "../commands-context.js";
import { createCommandRegistry } from "../commands-registry.js";
import type { CommandRegistryOptions } from "../commands-registry-types.js";
import { EnvironmentLifecycleTaskTracker } from "../environment-lifecycle-tasks.js";
import { runCommand } from "../shell.js";
import { StorageService } from "../storage.js";
import { stopReconciler } from "./reconciler.js";

/**
 * Real-storage harness for public actions: a temporary data directory, a
 * real `StorageService`, the real command registry and `public_action`, and
 * a real Git repository with a local bare origin. Only providers and Docker
 * are absent unless a test supplies them.
 */
export interface PublicApiHarness {
  dataDir: string;
  root: string;
  storage: StorageService;
  context: CommandContext;
  commands: Map<string, (args: Record<string, unknown>, context: CommandContext) => unknown>;
  call<T = unknown>(
    action: PublicActionName,
    input: Record<string, unknown>,
    request?: { requestId: string; namespace?: string },
  ): Promise<PublicActionResponse<T>>;
  createRepository(name: string): Promise<{ projectPath: string; originPath: string }>;
  /** A second storage/registry over the same data directory ("restart"). */
  restart(): Promise<PublicApiHarness>;
  cleanup(): Promise<void>;
}

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await runCommand("git", args, {
    ...(cwd ? { cwd } : {}),
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Orkestrator Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Orkestrator Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  return stdout.trim();
}

export async function createPublicApiHarness(
  options: {
    root?: string;
    dataDir?: string;
    context?: Partial<CommandContext>;
    registry?: CommandRegistryOptions;
  } = {},
): Promise<PublicApiHarness> {
  const root = options.root ?? (await fs.mkdtemp(path.join(os.tmpdir(), "ork-public-api-")));
  const dataDir = options.dataDir ?? path.join(root, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const storage = new StorageService(dataDir);
  await storage.init();
  const commands = createCommandRegistry(
    options.registry,
  ) as unknown as PublicApiHarness["commands"];
  const context = {
    storage,
    emit: () => undefined,
    appRoot: root,
    resourceRoot: root,
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    worktreeDir: path.join(root, "worktrees"),
    ...options.context,
  } as CommandContext;
  const harness: PublicApiHarness = {
    dataDir,
    root,
    storage,
    context,
    commands,
    async call(action, input, request) {
      const handler = commands.get("public_action")!;
      return (await handler(
        {
          schemaVersion: PUBLIC_API_SCHEMA_VERSION,
          action,
          actionVersion: PUBLIC_ACTIONS[action].version,
          input,
          ...(request ? { request } : {}),
        },
        context,
      )) as PublicActionResponse<never>;
    },
    async createRepository(name) {
      const projectPath = path.join(root, "repos", name);
      const originPath = path.join(root, "origins", `${name}.git`);
      await fs.mkdir(path.dirname(originPath), { recursive: true });
      await fs.mkdir(projectPath, { recursive: true });
      await git(["init", "--bare", "-b", "main", originPath]);
      await git(["init", "-b", "main"], projectPath);
      await fs.writeFile(path.join(projectPath, "README.md"), `# ${name}\n`);
      await git(["add", "README.md"], projectPath);
      await git(["commit", "-m", "initial"], projectPath);
      await git(["remote", "add", "origin", originPath], projectPath);
      await git(["push", "-u", "origin", "main"], projectPath);
      return { projectPath, originPath };
    },
    async restart() {
      await stopReconciler(storage);
      return createPublicApiHarness({
        root,
        dataDir,
        context: options.context,
        registry: options.registry,
      });
    },
    async cleanup() {
      await stopReconciler(storage);
      await context.environmentLifecycleTasks.beginShutdown?.(5_000).catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    },
  };
  return harness;
}

export async function headCommit(projectPath: string): Promise<string> {
  return git(["rev-parse", "HEAD"], projectPath);
}

export async function commitFile(
  projectPath: string,
  file: string,
  contents: string,
): Promise<string> {
  await fs.writeFile(path.join(projectPath, file), contents);
  await git(["add", file], projectPath);
  await git(["commit", "-m", `update ${file}`], projectPath);
  return git(["rev-parse", "HEAD"], projectPath);
}
