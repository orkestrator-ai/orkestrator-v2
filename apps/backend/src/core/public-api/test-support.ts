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
import { BackendRuntime } from "../backend-runtime.js";

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
  /**
   * Each first-prompt naming call the stub `codex` received, as its argument
   * list, oldest first.
   */
  namingCalls(): Promise<string[][]>;
  /** A second storage/registry over the same data directory ("restart"). */
  restart(): Promise<PublicApiHarness>;
  cleanup(): Promise<void>;
}

const NAMING_LOG = "codex-naming.log";

/**
 * A `codex` that answers first-prompt naming without the network. It sits at
 * `<root>/bin/codex`, the managed-binary path `resolveCodexBinary` checks
 * before falling back to `PATH`, so a CI runner's pinned Codex or a
 * developer's signed-in one is never reached.
 */
function namingStubScript(logPath: string): string {
  const quotedLog = `'${logPath.replaceAll("'", "'\\''")}'`;
  return `#!/bin/sh
tab=$(printf '\\t')
line=""
out=""
prev=""
for arg in "$@"; do
  line="$line$(printf '%s' "$arg" | tr '\\t\\n' '  ')$tab"
  if [ "$prev" = "--output-last-message" ]; then
    out="$arg"
  fi
  prev="$arg"
done
printf '%s\\n' "$line" >> ${quotedLog}
[ -n "$out" ] || exit 2
printf '%s\\n' '{"slug":"stub-named"}' > "$out"
`;
}

async function installNamingStub(root: string): Promise<void> {
  const stub = path.join(root, "bin", "codex");
  await fs.mkdir(path.dirname(stub), { recursive: true });
  await fs.writeFile(stub, namingStubScript(path.join(root, NAMING_LOG)), { mode: 0o755 });
}

/** One line per call; arguments are tab-separated with tabs and newlines flattened. */
function parseNamingLog(log: string): string[][] {
  return log
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t").slice(0, -1));
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
  await installNamingStub(root);
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
    runtime: new BackendRuntime({ emit: (event, payload) => context.emit(event, payload) }),
  } as CommandContext;
  let disposal: Promise<void> | undefined;
  function dispose(): Promise<void> {
    return (disposal ??= (async () => {
      try {
        await stopReconciler(storage);
      } finally {
        try {
          await context.environmentLifecycleTasks.beginShutdown(5_000);
        } finally {
          context.runtime.shutdown();
          storage.close();
        }
      }
    })());
  }
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
    async namingCalls() {
      const log = await fs.readFile(path.join(root, NAMING_LOG), "utf8").catch(() => "");
      return parseNamingLog(log);
    },
    async restart() {
      await dispose();
      return createPublicApiHarness({
        root,
        dataDir,
        context: options.context,
        registry: options.registry,
      });
    },
    async cleanup() {
      try {
        await dispose();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
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
